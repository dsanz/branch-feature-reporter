const JiraApi = require('jira-client');
const util = require('util');
const process = require('process');
const exec = require('child_process').execSync;
const PropertiesReader = require('properties-reader');
const fs = require('fs');

const jiraProps = PropertiesReader('jira.properties');

// Initialize
var jira = new JiraApi({
	protocol: 'https',
	host: 'issues.liferay.com',
	username: jiraProps.get('jira.username'),
	password: jiraProps.get('jira.password'),
	apiVersion: '2',
	strictSSL: true
});

var features = {}; // hierarchical grouping of epics, stories, tasks and subtasks found in git history
var resultCache = []; // all issues as returned by JIRA REST API
var gitHistoryIndex = {}; // all git history

// output related stuff
var logfile;
var timestamp = getTimeStamp();
var dirname = "out/" + timestamp;

/* logging */
function log(message, cfg) {
	if (cfg) {
		if (cfg.error == undefined) { cfg.error = false }
		if (cfg.newline == undefined) { cfg.newline = true }
	}
	else {
		cfg = { error:false, newline:true};
	}

	if (cfg.newline) {
		if (cfg.error) {
			console.error(message);
		} else {
			console.log(message);
		}
	}
	else {
		if (cfg.error) {
			process.stderr.write(message);
		} else {
			process.stdout.write(message);
		}
	}
	fs.appendFileSync(logfile, message + (cfg.newline ? "\n" : ""));
}

/*
 * Feature tree building
 */

/* get some data from json objects returned by JIRA REST API */
function buildIssueKey(issue) {	return issue.key + ': ' + issue.fields.summary; }
function getType(issue) { return issue.fields.issuetype.name;}
function getStatus(issue) { return issue.fields.status.name; }
function getEpicLink(issue) { return issue.fields.customfield_12821; }
function getSummary(issue) { return issue.fields.summary; }
function isEpic(issue) { return "Epic" == getType(issue) }
function isStory(issue) { return "Story" == getType(issue)}
function isTask(issue) {
	return ("Task" == getType(issue)) || ("Technical Task" == getType(issue));
}

// convert a JIRA issue to the JSON representation we want for output
function convert(issue) {
	//key = getType(issue) + " (" + issue.fields.status.name + ") ";
	return { "fields": { "summary": getSummary(issue),
			"status": getStatus(issue),
			"type": getType(issue) }}
}

function cacheIssue(issue) {
	resultCache[issue.key] = issue
}

async function findAndCacheIssue(issueKey) {
	const issue = await jira.findIssue(issueKey);
	cacheIssue(issue);
	return issue;
}

async function getParentIssue(issue) {
	if (issue.fields.parent) {
		if (!resultCache[issue.fields.parent.key]) {
			// parent may have been left out by the intital jira query. Fetch it
			await findAndCacheIssue(issue.fields.parent.key)
		}
		return resultCache[issue.fields.parent.key]
	}
	else return null;
}

// issue comes as the epic key as we add the epic via addStory so we just have the epic link field
async function addEpic(epicLink) { 
	//log("Adding epic " + issue)
	try {
		if (!features.epics[epicLink]) {
			features.epics[epicLink] = new Object();	// let add a placeholder just in case
			// epic may have been left out by the jira query. Fetch it
			const epic = await findAndCacheIssue(epicLink);
			features.epics[epicLink] = convert(epic)
		}
	}
	catch (err) {
		log(err, {error:true})
	}
	return features.epics[epicLink];
}

async function addStory(issue) {
	var placeholder = null;
	epicLink = getEpicLink(issue);
	if (epicLink) {
		//log("  story " + issue.key + " has epic")	
		placeholder = await addEpic(epicLink);
	}
	else {
		placeholder = features.stories;
	}
	if (!placeholder[issue.key]) {
		placeholder[issue.key] = convert(issue)
	}
	return placeholder[issue.key]
}

async function addTask(issue) {
	//log("Adding task " + issue.key)
	var placeholder = null;
	parent = await getParentIssue(issue);
	if (parent) {
		//log("   task " + issue.key + " has parent")
		if (isStory(parent)) {
			placeholder = await addStory(parent);
		}
		else if (isTask(parent)) {
			placeholder = await addTask(parent);
		}
		else {
			log(issue.key + " has a parent which is neither a story nor a task", {error:true});
			return null;
		}
	}
	else {
		epicLink = getEpicLink(issue);
		if (epicLink) {
			placeholder = await addEpic(epicLink);
		}
		else {
			placeholder = features.tasks;
		}
	}
	if (!placeholder[issue.key]) {
		placeholder[issue.key] = convert(issue)
	}
	return placeholder[issue.key]
}

async function addIssue(issue) {
	try {
		if (isStory(issue)) {
			await addStory(issue)
		}
		else if (isTask(issue)) {
			await addTask(issue)
		}
		else {
			log("Issue " + issue.key + " is neither a task or story, it should not have committed code", {error:true});
		}
	}
	catch (err) {
		log(err, {error:true})
	}
}

function resetFeatureTree() {
	features.epics={};   // tree of epics → stories → tasks → subtasks
	features.stories={}; // tree of stories → tasks → subtasks (stories w/o associated epic)
	features.tasks={};   // tree of tasks → subtasks (tech tasks not associated to stories nor epics)
}

async function buildFeatureTree(profile) {
	try {
		profileQuery = jiraProps.get('jira.query.' + profile);
		suffix = jiraProps.get('jira.common.query.prefix');

		query = profileQuery + (suffix ? " " + suffix : "")
		log("[" + profile + "] querying JIRA: " + query);
		const issues = await jira.searchJira(query, {maxResults: 500});

		log("[" + profile + "] Caching " + issues.issues.length + " issues");
		for (let index = 0; index < issues.issues.length; index++) {
			// can we cache issues from different profiles in the same data structure? Yes, if:
			//  1. we then check against just the ones returned by the last query
			//  2. we clean the features objecton each iteration
			cacheIssue(issues.issues[index])
		}

		log("[" + profile + "] Building feature tree from git history ", {newline:false});
		resetFeatureTree();
		issueCount = 0;
		lastPercentage = -1;
		for (let index = 0; index < issues.issues.length; index++) {
			percentage = Math.ceil(index * 100/ issues.issues.length)
			if (isTicketinCachedHistory(issues.issues[index])) {
				issueCount++;
				await addIssue(issues.issues[index])
			}
			if ((percentage !== lastPercentage) && (percentage % 5 === 0)) {
				log((percentage >0 ? "..":"") +percentage + "%", {newline:false});
				lastPercentage = percentage;
			}
		}
		log();
		log("[" + profile + "] " + issueCount + " out of " + issues.issues.length +
						" issues were found in git");

		process.chdir(process.env.PWD);
	}
	catch (err) {
		log(err, {error:true});
	}
}

/*
 * Git history: caching and checking
 */
function cacheGitHistory(){
	filterOptions = "| sed 's/.*/\\U&/' | sort | uniq | grep -v SUBREPO:IGNORE | grep -v ARTIFACT:IGNORE | grep -v \"RECORD REFERENCE TO LIFERAY-PORTAL\"";
	commitRange = jiraProps.get('branch.ref.from') + ".." + jiraProps.get('branch.ref.to');
	command = "git log --format=%s " + commitRange + filterOptions;
	try {
		stdout = exec(command);
		outArray = stdout.toString().split("\n");

		for (const line of outArray) {
			trimmed=line.trim();
			index = trimmed.substring(0, trimmed.indexOf(" "));
			if (!gitHistoryIndex[index]) {
				gitHistoryIndex[index] = trimmed
			}
			else {
				gitHistoryIndex[index] = gitHistoryIndex[index] + " " + trimmed
			}
		}
	}
	catch(err) {
		log(err, {error:true})
	}
}

function isTicketinCachedHistory(issue) {
	if (gitHistoryIndex[issue.key]) {
		return true;
	}
	else {
		for (k of Object.keys(gitHistoryIndex)) {
			if (gitHistoryIndex[k].toString().indexOf(issue.key) != -1) {
				return true;
			}
		}
	}
	return false;
}

async function readGitBranches() {
	log("Reading git branches and caching history");
	for (const branch of ["public", "private"]) {
		log("  →  " + jiraProps.get('branch.name.' + branch) +
					"@" + jiraProps.get('branch.dir.' + branch));
		process.chdir(jiraProps.get('branch.dir.' + branch));
		if (jiraProps.get('branch.sync')) {
			log("  →  Checking out " +
						jiraProps.get('branch.name.' + branch));
			await exec("git checkout " +
					   jiraProps.get('branch.name.' + branch));
			log(
					"  →  Pulling " + jiraProps.get('branch.name.' + branch) +
					" from upstream");
			await exec("git pull upstream " +
					   jiraProps.get('branch.name.' + branch))
		}
		cacheGitHistory();
	}
}

/*
 * Reporting
 */
function logCSVLine(fd, csvLine) {
	fs.appendFileSync(fd, Object.keys(csvLine).reduce( (total, k, i, a) => {
		return total + csvLine[k] + ((i == a.length -1 ) ? "" : "\t");
	}, "") + "\n");
}

function sanitize(text) {
	return text.replace(/\t/g," ");
}

function buildTicketURL(issueKey) {
	return "https://issues.liferay.com/browse/"+issueKey;
}

function buildCSVTicket(issueKey, issue, type) {
	issueString = (type ? ("[" + issue.fields.type +"] ") : "") +
				issueKey + " (" + issue.fields.status + ") → " +
				sanitize(issue.fields.summary)
	if (jiraProps.get('csv.gdoc')) {
		issueString = "=HYPERLINK(\"" + buildTicketURL(issueKey) + "\",\"" +
					  issueString.replace(/"/g, "'") + "\")"
	}
	return issueString;
}

function buildCSVLine(issueKey, issue, epicRendered, epicKey, epic) {
	epicLine = "none";
	if (epicKey && epic) {
		epicLine = epicRendered ? "" : buildCSVTicket(epicKey, epic)
	}
	return {
		"epic" : epicLine,
		"feature" : buildCSVTicket(issueKey, issue, issue.fields.type),
		"subtasks" : Object.keys(issue).reduce( (total, k, i, a) => {
			if (k == "fields") {
				return total;
			}
			return total + k + "(" + issue[k].fields.status + ")" + ((i == a.length -1) ? "" : ":");
		}, "")
	};
}

function smartSort(object) {
	keys = Object.keys(object)

	// separate into keys per project
	const sortedTree={}
	for (keyIndex in keys) {
		key = keys[keyIndex];
		project = key.substring(0, key.indexOf("-"));
		if (!sortedTree[project]) { sortedTree[project] = [] }
		number = key.substring(key.indexOf("-") + 1);
		sortedTree[project].push(number)
	}

	// sort keys within each project
	//log(sortedTree);
	for (project in sortedTree) {
		sortedTree[project] = sortedTree[project].sort((a, b) => a - b);
	}
	//log(sortedTree);

	// put everything back together into a single array of keys
	const result = []
	projects = Object.keys(sortedTree).sort();
	for (projectIndex in projects) {
		projectKey = projects[projectIndex];

		for (sortedIssueKeyIndex in sortedTree[projectKey]) {
			result.push(projectKey + "-" + sortedTree[projectKey][sortedIssueKeyIndex])

		}
	}
//	log(result);
	return result;
}

function printCSV(filename) {
	let fd;

	try {
		fd = fs.openSync(filename, 'a');
		fs.appendFileSync(fd, "Report:\t" + filename + "\n");
		fs.appendFileSync(fd, "Epic\tFeature\tSubtasks\n");
		epicKeys = smartSort(features.epics);
		for (epicIndex in epicKeys) {
			epicKey = epicKeys[epicIndex];
			if (!features.epics.hasOwnProperty(epicKey)) continue;
			epic = features.epics[epicKey];
			epicRendered = false;
			issueKeys = smartSort(epic);
			for (issueIndex in issueKeys) {
				issueKey = issueKeys[issueIndex]
				if ((issueKey == "fields") || !epic.hasOwnProperty(issueKey)) continue;
				issue = epic[issueKey];
				logCSVLine(fd, buildCSVLine(issueKey, issue, epicRendered, epicKey, epic));
				epicRendered = true;
			}
		}

		storyKeys = smartSort(features.stories);
		for (storyIndex in storyKeys) {
			storyKey = storyKeys[storyIndex];
			if (!features.stories.hasOwnProperty(storyKey)) continue;
			logCSVLine(fd, buildCSVLine(storyKey, features.stories[storyKey]));
		}

		taskKeys = smartSort(features.tasks);
		for (taskIndex in taskKeys) {
			taskKey = taskKeys[taskIndex];
			if (!features.tasks.hasOwnProperty(taskKey)) continue;
			logCSVLine(fd, buildCSVLine(taskKey, features.tasks[taskKey]));
		}

	} catch (err) {
		log(err, {error:true})
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function printJSON(filename) {
	let fd;

	try {
		fd = fs.openSync(filename, 'a');
		fs.appendFileSync(fd, util.inspect(features, {showHidden: false, depth:null, sorted:true, compact:false, breakLength:Infinity}) + "\n", 'utf8');
	} catch (err) {
		log(err, {error:true})
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	//log(util.inspect(features, {showHidden: false, depth:null, colors:true, sorted:true, compact:false, breakLength:Infinity}));
}

function pad(n) {
    return n<10 ? '0'+n : n;
}

function getTimeStamp() {
	let now = new Date();
	return now.getFullYear() + pad(now.getMonth()+1) + pad(now.getDate())+"-"+pad(now.getHours())+pad(now.getMinutes())+pad(now.getSeconds())
}

function writeReport(profile) {
	process.chdir(process.env.PWD);

	filename = dirname + "/" + profile + "_" + timestamp;
	if (jiraProps.get('json.enabled')) {
		log("[" + profile + "] Writing JSON report " + filename + ".json")
		printJSON(filename + ".json");
	}
	if (jiraProps.get('csv.enabled')) {
		log("[" + profile + "] Writing CSV report " + filename + ".csv")
		printCSV(filename + ".csv");
	}
}

function prepareLog() {
	if (!fs.existsSync(dirname)) {
		fs.mkdirSync(dirname);
	}
	logfile = fs.openSync(dirname + "/bfs.log", 'a');
}

async function run() {
	try {
		prepareLog();
		await readGitBranches();
		log("Building report for profiles " + jiraProps.get('profiles'));
		for (profile of jiraProps.get('profiles').split(",")) {
			await buildFeatureTree(profile);
			writeReport(profile);
		}
	}
	catch (err) {
		log(err, {error:true});
	}
	finally {
		if (logfile !== undefined) fs.closeSync(logfile);
	}
}

run();

