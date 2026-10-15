# MMM Community: step-by-step tutorial

**English** · [繁體中文](TUTORIAL.zh-Hant.md) · [简体中文](TUTORIAL.zh-Hans.md)

This tutorial follows the **Community beta browser edition** on macOS or Linux. Start with the local workflow: it needs no account, API key, or paid model. The AI steps are optional. Native Windows is not supported in this beta.

## 1. Start MMM

Install Node.js 24 or newer, then run:

```sh
git clone https://github.com/jacbus1/mmm-community.git
cd mmm-community
npm start
```

Open the **entire local URL printed in the terminal**, including the `#session=...` fragment. The server chooses an available port. Keep that URL private: the fragment grants access to this local session. Stop the server with `Ctrl+C` when finished. Choose a language in the welcome screen or the top-right menu.

![MMM Community home screen](screenshots/home.png)

## 2. Create a project and save a note

1. Select **Create your first project** or **New project**. Name it, for example, `Community library concept`, then select **Create project**. Source files and folders are optional; browser mode cannot attach them.
2. In **Conversation**, leave **Note** selected. Type a short brief, such as: `Design a community library booking page. Capture the user flow, mobile layout and accessibility checks.`
3. Select **Save note**. The text appears in the conversation and stays local. This does **not** call an AI service.

![A synthetic note in a local project](screenshots/project-workspace.png)

## 3. Complete a local task without AI

1. In the same **Conversation** composer, select **Local task**. Describe the deliverable and acceptance criteria; for example, `Draft a three-step booking flow and check keyboard navigation.` Select **Create local task**.
2. Open **Tasks**. The task appears there, and the **Workflow tree** shows recorded work. A local task does not execute itself.
3. After doing the work yourself, select **Submit result** on the task. Enter the actual result and submit it. MMM saves an artifact and moves the task to **awaiting review**.
4. Select **Review & accept**. Open the artifact, record what you checked in **Acceptance evidence**, tick the confirmation, and select **Approve completion**. Approval is what marks the task complete.
5. You can find the result under **Artifacts** and the action history under **Activity**.

If there is no real result yet, leave the task open; do not approve an empty or imagined deliverable.

## 4. Optionally connect an AI service

Use this section only if you want a provider to answer a task. Your provider may charge for requests.

1. Open **Settings & services** and expand **+ Connect a service** under **API connections · task execution**.
2. Select a provider, enter a model ID available to your own account, and add the API key if required. Only use an API endpoint you trust. Select **Save service settings**. Saving does not submit a task.
3. Optionally select **Test** on the saved connection and confirm the small test call; it may consume usage or incur a charge.

In browser mode, provider keys are held in server memory and must be entered again after a server restart. The key field is cleared after submission. **Website sign-in and manual CLI login are separate**; neither makes the website or CLI available for automatic Community team tasks.

## 5. Run one AI task

1. Return to the project **Conversation** and select **AI task**.
2. Choose the configured **AI service**. Write a precise, non-sensitive brief, including what a useful answer must contain.
3. Check **Content classification**, confirm that the text contains no keys or personal/private data, then select **Submit AI task**. Only this explicit submission sends the selected text to the provider.
4. Follow the status in **Tasks**. Read the saved response under **Artifacts**. If the provider fails or produces an incomplete result, the task will not be silently approved.
5. Use **Review & accept** only after checking the actual artifact and recording acceptance evidence. A retry sends a fresh request and requires fresh consent; it may cost more.

## 6. Optionally run a design-team discussion

1. Connect at least one compatible **API service** as in step 4. One connection may be assigned to several roles; multiple providers are optional.
2. Open the project's **Team** tab. Select **Use the design team** and confirm that you want a new draft. This creates four roles: coordinator, UI/UX designer, engineer, and reviewer. It does **not** start work.
3. Select an API service for **each** role, choose 1–3 discussion rounds, and select **Save team**. You may also edit names/roles or build a 1–8 member team manually.
4. In **Conversation**, select **AI task**, then **Use project team discussion**. Write a non-sensitive task. Confirm both the content check and the separate consent to share the brief and peer replies among the selected providers. Select **Submit AI task**.
5. Inspect real turns in **Tasks → Workflow tree** and the resulting artifact in **Artifacts**. The coordinator's synthesis and any agent replies are recorded only after they occur. Review the result and approve it with evidence as in step 5.

More agents and rounds can increase cost. This is text collaboration: the Community edition does not automatically edit files, run shell commands, or operate provider websites.

![Unconfigured four-role design-team draft](screenshots/design-team.png)

## 7. Keep your work and troubleshoot

- **Back up:** stop MMM, then copy the complete Community data directory to your own secure backup. See [Privacy and storage](../README.md#privacy-and-storage) for platform paths. Project data is not encrypted at rest; use OS disk encryption.
- **Export a task outline:** in **Team → Project tools**, choose **Export Markdown**. It contains task metadata, not notes, provider keys, source paths, full results, or a complete backup. Importing an MMM Markdown proposal requires a preview and explicit confirmation and creates local-only tasks.
- **No AI service shown:** connect an API service in **Settings & services**. A website tab or CLI login is not an API connection.
- **Task awaiting review:** open the artifact and provide acceptance evidence. MMM never approves a task merely because a provider returned text.
- **Session not accepted:** reopen the complete URL from the current `npm start` terminal. A new launch gets a new session fragment.
- **Browser file buttons disabled:** file/folder source references require the optional desktop bridge; browser mode still supports projects, notes and local tasks.

For capabilities and limits, read the [English README](../README.md). Report reproducible bugs through [GitHub Issues](https://github.com/jacbus1/mmm-community/issues) without including keys, session URLs, or private project data.
