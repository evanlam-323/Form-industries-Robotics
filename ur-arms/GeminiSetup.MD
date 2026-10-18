# Gemini AI Assistant — Setup

## Get a free Gemini API key
1. Go to https://aistudio.google.com/apikey
2. Create a key (free tier is generous for this use case).

## Run the relay with the key set
```bash
# macOS/Linux
export GEMINI_API_KEY="your-key-here"
python3 relay.py

# Windows (cmd)
set GEMINI_API_KEY=your-key-here
python3 relay.py
```
If the key isn't set, the widget will show a clear error instead of failing silently.

## Try it
Open the pendant UI, click the 💬 button bottom-right, and ask things like:
- "What's the Z height of my PICK position?"
- "What does movec need to work?"
- "Why would my loop never execute?"
- "Explain what step 3 does."

## Notes / next steps
- The assistant currently **only answers questions** — it cannot edit positions/steps.
  That matches "option 1" from our plan. Options 2 (generate program JSON) and 3
  (apply directly to the UI) can reuse this same relay proxy and context-gathering code —
  we'd just add stricter structured-output prompting (your `JSONBuilderCode.md` is already
  written almost exactly like a system prompt for that) and a validation step before
  anything touches `state.js`.
- Context sent per question is currently the full positions/steps list. If projects get
  very large you may want to trim this (e.g. only send steps near the one referenced).
