**/Sessions Page**
- SSE on main page:
  - The only thing reactive to updates seems to be timestamp. tokens, message count, tool count does not update via sse.
  - We should add a badge to the session for each update it receives since we've been on the page to show live updates streaming in. (UChip would work with the label/text prop)
- Sessions Detail Page:
  - Introduce a split-pane view on this page similar to what we have done on other pages. Details on left and messages on the right. Resizable pane. You can reference the layout on the voice page.
  - We should autoscroll to the bottom of the session transcript just like as it was a real message log and go to the bottom when a new message comes in.
  - Ensure messages, tool calls, token counts are updated via sse
  - We should first load the metadata (title, description, stats, etc) Then load the long transcripts so that on longer sessions the whole page is not just sitting in a loading state

**Project Association**
This lays the groundwork for future project-linking but essentially when a session is created, we should run a function like `findOrCreateProject()` which will create a new project or find an existing one. We will want to expand the projects table to include links for repository url, production url, staging url, aliases string array? and a jsonb column for "additional details" that we will expose via the frontend ui later as a key-value situation for storing stuff like if I want links to a url associated with the project, etc. Anything else you think would be useful?
Additionally - this will expand to other tables having a reference to this project such as:
- Enrichment service should also findOrCreateProject
- Memories should try to associate with a project unless the LLM determines that it explicitly is a user, project agnostic memory (which is acceptable, such as "Tony prefers PNPM over NPM")
- Documents should try to associate to a project.
- We should move project documents to `/Projects/<project-name>/**` automatically

**System-level Gaps**
- No memories were enriched from the sessions we have
- In our backfill script we need to capture the dates the memories originated from so that when we refine our reranking/searching strategy, we can use the date as a means to either dedupe/superseed memories or to determine if the memories are relevant still.

**findOrCreateProject**
We will need to be explicit about how this is done with features such as:
- "merging" projects in the event that two projects are created that are actually the same, we can easily merge the projects, promoting one, deleting the other, and updating all links to the deleted project to the new one.
- We need to be sure the "find" part of `findOrCreateProject` is robust enough so that we avoid duplication
- We need to call this function anywhere new data is created such as documents/ocr/transcription, memory capture, agent tool, etc.