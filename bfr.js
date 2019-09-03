const JiraApi = require('jira-client');
const util = require('util');
const process = require('process');
const exec = require('child_process').execSync;
const PropertiesReader = require('properties-reader');
//const mod = require('./mod');

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


var epics = new Object(); // stories grouped by epic
var stories = new Object() ; // stories w/o associated epic
var tasks = new Object(); // tech tasks not associated to stories nor epics
var resultCache = []; // all issues as returned by JIRA REST API
var gitHistoryIndex = {} // all git history

/* get some data from json objects returned by JIRA REST API */
function buildIssueKey(issue) {	return issue.key + ': ' + issue.fields.summary; }
function getType(issue) { return issue.fields.issuetype.name;}
function getStatus(issue) { return issue.fields.status.name; }
function getEpicLink(issue) { return issue.fields.customfield_12821; }
function getSummary(issue) { return issue.fields.summary; }
function isEpic(issue) { return "Epic" == getType(issue) }
function isStory(issue) { return "Story" == getType(issue)	}
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
		if (!resultCache[issue.fields.parent.key]) { // parent may have been filtered out by the jira query
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
		if (!epics[epicLink]) {
			epics[epicLink] = new Object();	// let add a placeholder just in case
			// epic may have been filtered out by the jira query
			const epic = await findAndCacheIssue(epicLink)
			epics[epicLink] = convert(epic)
		}
	}
	catch (err) {
		console.error(err)
	}
	return epics[epicLink];
}

async function addStory(issue) {
	epicLink = getEpicLink(issue)
	if (epicLink) {
		//console.log("  story " + issue.key + " has epic")	
		epic = await addEpic(epicLink)
		if (!epic[issue.key]) {
			epic[issue.key] = convert(issue)
		}
		return epic[issue.key]
	}
	else {
		if (!stories[issue.key]) {
			stories[issue.key] = convert(issue)
		}
		return stories[issue.key]
	}
}

async function addTask(issue) {
	//console.log("Adding task " + issue.key)	
	parent = await getParentIssue(issue)
	if (parent) {
		//console.log("   task " + issue.key + " has parent")	
		if (isStory(parent)) {
			story = await addStory(parent)
			if (!story[issue.key]) {
				story[issue.key] = convert(issue);
			}
			return story[issue.key]
		}
		else if (isTask(parent)) {
			task = await addTask(parent);
			if (!task[issue.key]) {
				task[issue.key] = convert(issue)
			}
			return task[issue.key]
		}
		else {
			console.log(issue.key + " has a parent which is neither a story nor a task")
			return null;
		}
	}
	else {
		epicLink = getEpicLink(issue)
		if (epicLink) {
			epic = await addEpic(epicLink)
			if (!epic[issue.key]) {
				epic[issue.key] = convert(issue)
			}
			return epic[issue.key]
		}
		else {
			if (!tasks[issue.key]) {
				tasks[issue.key] = convert(issue)
			}
			return tasks[issue.key]
		}
	}
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

function cacheGitHistory(){
	filterOptions = "| sed 's/.*/\\U&/' | sort | uniq | grep -v SUBREPO:IGNORE | grep -v ARTIFACT:IGNORE | grep -v \"RECORD REFERENCE TO LIFERAY-PORTAL\""
	commitRange = jiraProps.get('branch.ref.from') + ".." + jiraProps.get('branch.ref.to')
	command = "git log --format=%s " + commitRange + filterOptions;
	try {
		stdout = exec(command);
		outArray = stdout.toString().split("\n")

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

function logCSVLine(csvLine) {
	console.log(Object.keys(csvLine).reduce( (total, k, i, a) => {
		return total + csvLine[k] + ((i == a.length -1 ) ? "" : "\t");
	}, ""));
}

function buildCSVLine(issueKey, issue, epicRendered, epicKey, epic) {
	epicLine = "none"
	if (epicKey && epic) {
		epicLine = epicRendered ? "" : (epicKey + ": " + sanitize(getSummary(epic)));
	}
	return {
		"epic" : epicLine,
		"feature" : "[" + getType(issue) +"] → " + sanitize(getSummary(issue)) + "",
		"LPS" : issueKey,
		"status": getStatus(issue),
		"subtasks" : Object.keys(issue).reduce( (total, k, i, a) => {
			if (k == "fields") {
				return total;
			}
			return total + k + "(" + getStatus(issue[k]) + ")" + ((i == a.length -1) ? "" : ":");
		}, "")
	};
}


function printCSV(data) {
	epics = data["EPICS"]

	console.log("Epic\tElement/Feaure\tLPS\tStatus\tSubtasks");
	for (epicKey in epics) {
		epic = epics[epicKey];
		epicRendered = false;
		for (issueKey in epic) {
			if (issueKey == "fields") { continue; }
			issue = epic[issueKey];
			logCSVLine(buildCSVLine(issueKey, issue, epicRendered, epicKey, epic));
			epicRendered = true;
		}
	}

	stories = data["STORIES W/O EPIC"];
	for (storyKey in stories) {
		logCSVLine(buildCSVLine(storyKey, stories[storyKey]));
	}

	tasks = data["TASKS W/O STORY"];
	for (taskKey in tasks) {
		logCSVLine(buildCSVLine(taskKey, tasks[taskKey]));
	}
}

function printJSON(data) {
	console.log(util.inspect(data, {showHidden: false, depth:null, colors:true, sorted:true, compact:false, breakLength:Infinity}));
}

async function getTickets() {
	try {
		console.log("Querying JIRA: " + jiraProps.get('jira.query'));
		const issues = await jira.searchJira(
				jiraProps.get('jira.query'), {maxResults: 500})

		console.log("Caching " + issues.issues.length + " issues")
		for (let index = 0; index < issues.issues.length; index++) {
			cacheIssue(issues.issues[index])
		}

		for (const branch of ["public", "private"]) {
			console.log("Processing " + jiraProps.get('branch.name.' + branch) +
						"@" + jiraProps.get('branch.dir.' + branch));

			process.chdir(jiraProps.get('branch.dir.' + branch));
			cacheGitHistory();
			if (jiraProps.get('branch.sync')) {
				console.log("Checking out " +
							jiraProps.get('branch.name.' + branch))
				await exec("git checkout " +
						   jiraProps.get('branch.name.' + branch))
				console.log(
						"Pulling " + jiraProps.get('branch.name.' + branch) +
						" from upstream")
				await exec("git pull upstream " +
						   jiraProps.get('branch.name.' + branch))
			}
		}

		console.log("Building feature tree from git history");
		issueCount = 0;
		for (let index = 0; index < issues.issues.length; index++) {
			char = '·'
			if (isTicketinCachedHistory(issues.issues[index])) {
				char = "*"
				issueCount++;
				await addIssue(issues.issues[index])
			}
			process.stdout.write(char)
		}
		console.log()
		console.log(issueCount + " out of " + issues.issues.length +
						" issues were found in git")

		var all = new Object();
		all["EPICS"]=epics;
		all["STORIES W/O EPIC"]=stories;
		all["TASKS W/O STORY"]=tasks;
		process.chdir(process.env.PWD)
		return all;
	}
	catch (err) {
		console.log(err);
	}
}

async function run() {
	try {
		var tickets = await getTickets();
		printJSON(tickets)
		printCSV(tickets)
	}
	catch (err) {
		console.log(err);
	}
}

//mod.testmod()

run();

