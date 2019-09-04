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

function sanitize(text) {
	return text.replace(/\t/g," ");
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
	//console.log("Adding epic " + issue)
	try {
		if (!features.epics[epicLink]) {
			features.epics[epicLink] = new Object();	// let add a placeholder just in case
			// epic may have been left out by the jira query. Fetch it
			const epic = await findAndCacheIssue(epicLink);
			features.epics[epicLink] = convert(epic)
		}
	}
	catch (err) {
		console.error(err)
	}
	return features.epics[epicLink];
}

async function addStory(issue) {
	var placeholder = null;
	epicLink = getEpicLink(issue);
	if (epicLink) {
		//console.log("  story " + issue.key + " has epic")	
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
	//console.log("Adding task " + issue.key)
	var placeholder = null;
	parent = await getParentIssue(issue);
	if (parent) {
		//console.log("   task " + issue.key + " has parent")
		if (isStory(parent)) {
			placeholder = await addStory(parent);
		}
		else if (isTask(parent)) {
			placeholder = await addTask(parent);
		}
		else {
			console.log(issue.key + " has a parent which is neither a story nor a task");
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
			console.log("Issue " + issue.key + " is neither a task or story, it should not have committed code");
		}
	}
	catch (err) {
		console.log(err)
	}
}

function resetFeatureTree() {
	features.epics={};   // tree of epics → stories → tasks → subtasks
	features.stories={}; // tree of stories → tasks → subtasks (stories w/o associated epic)
	features.tasks={};   // tree of tasks → subtasks (tech tasks not associated to stories nor epics)
}

async function buildFeatureTree(profile) {
	try {
		query = jiraProps.get('jira.query.' + profile);
		console.log(profile + " →  querying JIRA: " + query);
		const issues = await jira.searchJira(query, {maxResults: 500});

		console.log("Caching " + issues.issues.length + " issues");
		for (let index = 0; index < issues.issues.length; index++) {
			// can we cache issues from different profiles in the same data structure? Yes, if:
			//  1. we then check against just the ones returned by the last query
			//  2. we clean the features objecton each iteration
			cacheIssue(issues.issues[index])
		}

		console.log(profile + " →  Building feature tree from git history");
		resetFeatureTree();
		issueCount = 0;
		for (let index = 0; index < issues.issues.length; index++) {
			char = '·';
			if (isTicketinCachedHistory(issues.issues[index])) {
				char = "*";
				issueCount++;
				await addIssue(issues.issues[index])
			}
			process.stdout.write(char)
		}
		console.log();
		console.log(profile + " →  " + issueCount + " out of " + issues.issues.length +
						" issues were found in git");

		process.chdir(process.env.PWD);
	}
	catch (err) {
		console.log(err);
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
		console.log(err)
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
	for (const branch of ["public", "private"]) {
		console.log("Reading git history from " + jiraProps.get('branch.name.' + branch) +
					"@" + jiraProps.get('branch.dir.' + branch));

		process.chdir(jiraProps.get('branch.dir.' + branch));
		if (jiraProps.get('branch.sync')) {
			console.log("Checking out " +
						jiraProps.get('branch.name.' + branch));
			await exec("git checkout " +
					   jiraProps.get('branch.name.' + branch));
			console.log(
					"Pulling " + jiraProps.get('branch.name.' + branch) +
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

function buildCSVLine(issueKey, issue, epicRendered, epicKey, epic) {
	epicLine = "none";
	if (epicKey && epic) {
		epicLine = epicRendered ? "" : (epicKey + "("+ epic.fields.status + "): " + sanitize(epic.fields.summary));
	}
	return {
		"epic" : epicLine,
		"feature" : "[" + issue.fields.type +"] → " + sanitize(issue.fields.summary) + "",
		"LPS" : issueKey,
		"status": issue.fields.status,
		"subtasks" : Object.keys(issue).reduce( (total, k, i, a) => {
			if (k == "fields") {
				return total;
			}
			return total + k + "(" + issue[k].fields.status + ")" + ((i == a.length -1) ? "" : ":");
		}, "")
	};
}

function printCSV(filename) {
	let fd;

	try {
		fd = fs.openSync(filename, 'a');
		fs.appendFileSync(fd, "Epic\tElement/Feaure\tLPS\tStatus\tSubtasks");
		for (epicKey in features.epics) {
			epic = features.epics[epicKey];
			epicRendered = false;
			for (issueKey in epic) {
				if (issueKey == "fields") { continue; }
				issue = epic[issueKey];
				logCSVLine(fd, buildCSVLine(issueKey, issue, epicRendered, epicKey, epic));
				epicRendered = true;
			}
		}

		for (storyKey in features.stories) {
			logCSVLine(fd, buildCSVLine(storyKey, features.stories[storyKey]));
		}

		for (taskKey in features.tasks) {
			logCSVLine(fd, buildCSVLine(taskKey, features.tasks[taskKey]));
		}

	} catch (err) {
		console.log(err)
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
		console.log(err)
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	//console.log(util.inspect(features, {showHidden: false, depth:null, colors:true, sorted:true, compact:false, breakLength:Infinity}));
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
	if (!fs.existsSync("out")) {
		fs.mkdirSync("out");
	} 
	timestamp = getTimeStamp();
	filename = "out/" + profile + "_" + timestamp;
	console.log(profile + " →  Writing report " + filename)
	printJSON(filename + ".json");
	printCSV(filename + ".csv");
}

async function run() {
	try {
		await readGitBranches();

		for (profile of jiraProps.get('profiles').split(",")) {
			await buildFeatureTree(profile);
			writeReport(profile);
		}
	}
	catch (err) {
		console.log(err);
	}
}

console.log()
run();

