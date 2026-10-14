---
name: connect
description: Connect this app's folder to a QA Hub project, or check the QA Hub connection (API key, plan, the computer tests run on). Use when the user says "connect to QA Hub", gives a project name, or the qahub tools report a key or computer problem.
---

# Connect to QA Hub

1. Call `qahub_status`.
   - **Key missing or not valid:** tell the user to make a new key in QA Hub → Account → API keys, then run the setup command shown in the project's Settings → Claude ("Paste this into your Terminal") again — it asks for the key and saves it. (Or `/plugin` → **qahub** → configure.) The key is kept in the system keychain; never ask them to paste it into the chat or a file.
   - **Plan ended:** tell them to renew in QA Hub. Nothing else will work until then.
   - **Computer not connected:** tests can be sent but not run. Tell them to open QA Hub → Computers and run the connect command it shows, in a terminal on the computer where the app runs, and leave it open.
2. If the user named a project (e.g. `/qahub:connect freight-portal`), call `qahub_link` with it. Otherwise show the projects from the status and ask which one.
3. Confirm in one line: who is connected, which project this folder sends tests to, and whether tests can run now.
