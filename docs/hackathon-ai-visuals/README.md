# Hackathon AI Visuals

Presentation-friendly HTML pages for explaining the AI pipeline in sequence.

## Files

- `index.html` - intro + timeline
- `01-ai-landscape.html` - all AI systems in one view
- `02-stage-map.html` - AI mapped to pipeline stages
- `03-why-this-ai.html` - model/tool to outcome mapping
- `04-reliability.html` - guardrails and QA story
- `05-graphify.html` - Graphify + closing message

## Usage

Open `index.html` in a browser and use:

- Right Arrow = next page
- Left Arrow = previous page

## Graphify added to repo

`graphify` has been added at:

- `tools/graphify`

You can run it against this project (or selected folders) to generate an architecture graph:

```bash
cd "tools/graphify"
pip install graphifyy && graphify install
cd "../.."
graphify ./scripts --wiki --svg
```

Then open:

- `graphify-out/graph.html`
