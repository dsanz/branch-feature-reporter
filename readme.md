# Branch Feature Reporter

Given a JIRA query and a commit range in a branch, this script reports features (epics/stories) 
 which have commits within the commit range and are returned by the query.
  
It works as follows:
* JIRA query is run
* Branch is inspected to find traces of each ticket returned by the query
* If ticket is found, it's added to the report, together with the "parent" feature (if it exists)
* Features are hierarchically grouped by Epic/Story/Task levels using JIRA information.

As a result, if a technical task returned by the JIRA query has commits in the range, the corresponding story and epic (if exists) will be added to the report.

Report is given in JSON and CSV formats. A few, essential information is added to each ticket such as summary, type and status.

## Usage
### Configuration
Tool reads `jira.properties` file in the directory from where it's invoked. 
List of properties that must be present:

```properties
 ###############################
 # jira
 
 # server connection 
 jira.username=user.name
 jira.password=****
 
 # profiles we want to use to generate separate reports
 profiles=echo,lima
 
 # queries returning tickets we want to check for existence in the source history
 # note how profile is used as a property suffix
 jira.query.echo=filter = "Components | LPS-Echo"
 jira.query.lima=filter = "Components | LPS-Lima"

 # if present, the value of this property will be added to all profile queries
 jira.common.query.prefix=and status changed after "2019/05/31" and issuetype in (Task, "Technical Task", Story)

 
 ###############################
 # source code
 
 # where is the code?
 branch.dir.public=/home/dsanz/projects/72x/7.2.x
 branch.dir.private=/home/dsanz/projects/72x/7.2.x-private
 
 # do we want to sync the branch before running? 
 branch.sync=true
 
 # name of the branches. Script works with 2 branches to find commits both in public and private code
 branch.name.public=7.2.x
 branch.name.private=7.2.x-private
 
 # commit range to look for existence of tickets returned by query. Range must be valid in both branches
 branch.ref.from=7.2.0-ga1
 branch.ref.to=HEAD

 ###############################
 # reporting
 
 # generate report in CSV
 csv.enabled=true
 
 # include links to the tickets for the CSV to be imported in google spreadsheets
 csv.gdoc=true
  
 # generate report in json
 json.enabled=false 
```
### Command-line invocation
No need to pass parameters, just checkout the repo and run via node:
```bash
~/branch-feature-reporter [master]$ ls
bfr.js  jira.properties  ...
~/branch-feature-reporter [master]$ node bfr.js 
```
### Report contents

# Features to come
* Diffs between outputs
* Look for related documentation tickets and report status (both LPS of specific type + LRDOCS ticket)
* Look for qa tickets, report status and linked documents
* Give a file filter to check story of those files rather than full repo history. This would catch features changing things that customers customize