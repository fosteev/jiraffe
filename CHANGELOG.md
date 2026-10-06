# Changelog

## 0.5.0

- Issues: a toolbar toggle between a flat list and a tree grouped by project (instance → project → issues). Not shown in Project mode.
- Epics: “Only My Epics / All Epics” toggle (assignee is you) and a search by epic name; an issue key in the search shows an “Open … by key” row.

## 0.4.0

- Quick Filters: a Project group to narrow any view (Assigned to Me, JQL) to several projects. Applied in the query, so counts and paging stay correct; a project missing on an instance is skipped there.

## 0.3.0

- English UI by default; Russian when VS Code runs in Russian.
- First Marketplace and Open VSX release. The extension ID is now `fosteev.jiraffe`: if you installed an earlier `.vsix` (`jiraffe.jiraffe`), uninstall it and add your instances again.

## 0.2.0

- Change status: click the status in the issue card, use the issue context menu in the tree, or the Command Palette. Only transitions available to you are offered; required transition fields with a list of values (resolution, etc.) are asked for in a picker, others offer to open the issue in Jira. The card, Issues, Epics and Releases refresh after a transition.
- Instances per workspace: the `jiraffe.instances` setting and the "Workspace Instances" command. Connections and tokens stay shared; mode, project, quick filters and the Epics/Releases project are remembered per workspace.

## 0.1.0

First version: reading and work logging, no issue editing.

- Several Jira instances at once: Server / Data Center 8.22+ (Personal Access Token) and Cloud (email + API token); tokens in SecretStorage.
- Issues: assigned to me, by project, any JQL, quick filters (status category, type, priority, instance), search by key and text, paging for long lists.
- Filters: your saved filters and Jira favorites.
- Issue card: description, comments, change history, work log, people, details, epic and release links; pinning.
- Attachments: image previews in the description and comments, lightbox, download one or all, open text files in the editor.
- Work log: log time from the card or the tree; Tempo (work attributes, including "AI Tokens") or the standard worklog; double-submit protection.
- Tempo view and status bar: time logged today against your workday.
- Epics and Releases: per-section project, epic progress, epic and release tabs (summary, segmented bar, issue table).
- Settings: `jiraffe.maxResults`, `jiraffe.attachmentsDir`, `jiraffe.maxImageMb`, `jiraffe.workdayHours`.
