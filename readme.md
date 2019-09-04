# Branch Feature Reporter

This script reports features for which there are commits in the given commit range and which match with a JIRA filter. 
It works as follows:
* JIRA query is run
* Branch is inspected to find traces of each ticket returned by the query
* If ticket is found, it's added to the report
* Features are hierarchically grouped by Epic/Story/Task levels using JIRA information.

Report is given in JSON and CSV formats. A few, essential information is added to each ticket such as summary, type and status.

## Usage
### Configuration
Tool reads jira.properties file in the directory from where it's invoked. 
List of properties that must be present:

```
 ###############################
 # jira
 
 # profiles we want to use
 profiles=echo,lima
 
 # server connection 
 jira.username=user.name
 jira.password=****
 
 # queries returning tickets we want to check for existence in the source history
 jira.query.echo=filter = "Components | LPS-Lima" and status changed after "2019/05/31" and issuetype in (Task, "Technical Task", Story)
 jira.query.lima=filter = "Components | LPS-Lima" and status changed after "2019/05/31" and issuetype in (Task, "Technical Task", Story)
 
 ###############################
 # source code
 
 # where is the code?
 branch.dir.public=/home/dsanz/projects/72x/7.2.x
 branch.dir.private=/home/dsanz/projects/72x/7.2.x-private
 
 # do we want to sync the branch before running? which one?
 branch.sync=true
 branch.name.public=7.2.x
 branch.name.private=7.2.x-private
 
 # commit range to look for existence of tickets returned by query
 branch.ref.from=7.2.0-ga1
 branch.ref.to=HEAD` 
```
### Command-line invocation

### Report contents

# Features to come
Profiles to store many queries in this file. Output files saved by profile. Date/time stamps on output. Diffs between outputs