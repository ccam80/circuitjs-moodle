# Getting Started & Debug Plan

## Project Overview

This is a browser-based port of [hneemann/Digital](https://github.com/hneemann/Digital) (v0.31), a Java/Swing digital logic simulator, running via [CheerpJ 4.2](https://cheerpj.com/) for embedding in online course tutorials. No server-side Java required.

## Architecture

~~~
tutorial.html  <-  primary entry point, loads tutorial.json
    | iframe
digital.html   <-  CheerpJ Swing loader, runs Digital.jar in browser
    | postMessage (hot-reload checkpoints)
    | cheerpjRunJar() for GUI
bridge.html    <-  headless CheerpJ library mode (future grading)
~~~

- `tutorial.html` fetches `tutorial.json`, renders step-by-step instructions in a left panel, embeds `digital.html` in an iframe on the right
- `digital.html` loads CheerpJ 4.2 from CDN, runs `Digital.jar` as a full Swing app, listens for `postMessage` to hot-load `.dig` checkpoint files
- `bridge.html` runs Digital.jar in headless library mode for simulation/test grading (future STACK/Moodle integration)
- `test-bridge.html` is an integration test harness for both modes

## Files

| File | Purpose |
|---|---|
| `Digital.jar` | hneemann/Digital v0.31 (3.7 MB Swing app) |
| `tutorial.html` | Split-pane tutorial viewer (instructions + live sim) |
| `tutorial.json` | Tutorial step definitions (title, HTML content, checkpoint .dig path) |
| `digital.html` | CheerpJ Swing loader, embeddable in iframe, postMessage API |
| `bridge.html` | Headless simulation bridge (CheerpJ library mode) |
| `test-bridge.html` | Integration test harness with GUI and headless tabs |
| `stack-question-template.txt` | Template for future Moodle/STACK grading |
| `circuits/*.dig` | Example checkpoint circuits (AND gate, half adder, SR latch) |

## Serving Locally — REQUIRED

**These files MUST be served over HTTP, not opened as file:// URLs.** CheerpJ, fetch(), and iframe cross-origin all require HTTP. This is almost certainly why tutorial.json fails to load and CheerpJ stalls.

Start a local server from the repo root:

~~~bash
# Python (simplest)
python3 -m http.server 8080

# Node
npx serve .

# PHP
php -S localhost:8080
~~~

Then open: `http://localhost:8080/tutorial.html`

## Known Issues to Debug (in priority order)

### 1. IMMEDIATE: tutorial.json fetch fails / CheerpJ loading wheel stuck

**Root cause (most likely):** Files opened via `file://` protocol. Both `fetch('tutorial.json')` and CheerpJ's CDN loader fail under `file://`.

**Fix:** Serve over HTTP as described above.

**If it still fails after serving over HTTP:**
- Check browser console (F12) for the actual error
- Verify `tutorial.json` is valid: `python3 -m json.tool tutorial.json`
- The CheerpJ loading wheel is independent of tutorial.json — it loads from `https://cjrtnc.leaningtech.com/4.2/loader.js` and needs internet access
- CheerpJ's own splash screen may overlay the page; `digital.html` sets `status: "none"` to suppress it but shows its own spinner until Digital starts

### 2. CheerpJ + Digital.jar first launch

**Expected:** CheerpJ downloads ~10 MB runtime on first visit (cached after), then starts the JVM and launches Digital's Swing GUI.

**What will likely go wrong:**
- Digital calls `Preferences` / `java.util.prefs` on startup -> CheerpJ may not support this. Fix: catch/ignore the exception (it's non-fatal, Digital falls back).
- Digital's splash screen (`SplashScreen-Image` in MANIFEST) may fail -> non-fatal.
- Digital tries to read `~/.digital.cfg` settings file -> won't exist in CheerpJ's virtual FS, Digital creates defaults. Should be fine.
- Look & Feel initialization (`UIManager.setLookAndFeel`) may throw -> Digital catches this already.
- `CheckForNewRelease` makes an HTTP request to GitHub -> may fail due to CORS. Non-fatal (Digital catches it).

**Debug approach:** Open browser console, launch `digital.html` standalone (not via tutorial.html), watch for Java exceptions in the console. CheerpJ logs Java stack traces to the browser console. Fix each one that prevents the Swing window from appearing.

### 3. Hot-reload checkpoints via postMessage

**How it works:** `digital.html` listens for `{ type: 'digital-load-url', url: '...' }` messages. It fetches the .dig file, injects it into CheerpJ's virtual filesystem via `cheerpOSAddStringFile('/str/checkpoint_N.dig', bytes)`, then uses `cheerpjRunLibrary()` to get a library handle, calls `Frame.getFrames()` to find the running `Main` instance, and calls `main.loadFile(file, false, false)`.

**What will likely go wrong:**
- `cheerpjRunLibrary()` may conflict with the already-running `cheerpjRunJar()` — CheerpJ may not support both in the same page. If this fails, the fallback is to reload the iframe with a new `?dig=` URL parameter (slower, restarts the JVM).
- `Frame.getFrames()` may return the frame but casting/method resolution on `Main.loadFile()` may fail if CheerpJ's proxy doesn't resolve the method signature. `loadFile(File, boolean, boolean)` is a public method on `de.neemann.digital.gui.Main`.
- The `/str/` virtual path may confuse Digital's `loadFile()` which calls `file.getParentFile()` to set the library root for subcircuit resolution.

**Fallback if hot-reload doesn't work:** In `tutorial.html`, change the checkpoint loading to reload the iframe instead:

~~~javascript
// Replace the postMessage approach with iframe reload:
simFrame.src = 'digital.html?dig=' + encodeURIComponent(checkpointUrl);
~~~

This restarts the JVM (~5s) but is 100% reliable.

### 4. Headless bridge (bridge.html, lower priority)

The headless bridge uses `cheerpjRunLibrary()` to call Digital's Java API directly:
- `Circuit.loadCircuit(file, shapeFactory)` — XStream XML deserialization
- `ModelCreator.createModel()` / `Model.doStep()` — simulation
- `TestExecutor.execute()` — test case grading

**What will likely go wrong:**
- `ElementLibrary` constructor uses reflection to register ~100+ component types. CheerpJ's reflection support may be incomplete.
- XStream (Digital's XML parser) uses reflection heavily.
- The class/method names in `bridge.html` are best-guesses from reading Digital's source — some may be wrong (private methods, different signatures, inner classes). Check against the actual Digital source at https://github.com/hneemann/Digital/tree/master/src/main/java/de/neemann/digital

### 5. Swing rendering quality (cosmetic)

CheerpJ renders Swing to HTML5 canvas. Expect:
- Slightly different text rendering/sizing
- Mouse hit-testing may be off by a few pixels
- Right-click context menus may feel sluggish
- Keyboard shortcuts may conflict with browser (Ctrl+S, Ctrl+Z are intercepted by `digital.html`'s `overrideShortcuts` config)

## Key CheerpJ 4.2 API Reference

~~~javascript
// Initialize (call once)
await cheerpjInit({ clipboardMode: "system", status: "none" });

// Create Swing display (before running JAR)
cheerpjCreateDisplay(-1, -1, document.getElementById("container"));

// Run a JAR (blocks until app exits — for Swing, effectively forever)
await cheerpjRunJar("/app/Digital.jar", "/str/circuit.dig");

// Library mode (call Java methods from JS)
const lib = await cheerpjRunLibrary("/app/Digital.jar");
const MyClass = await lib.com.example.MyClass;
const obj = await new MyClass("arg");
await obj.method();

// Inject files into virtual FS (after cheerpjInit)
cheerpOSAddStringFile("/str/myfile.dig", uint8ArrayOrString);

// /app/ = read-only, maps to web server root
// /str/ = read-only from Java, injected from JS
// /files/ = read-write, persisted in IndexedDB
~~~

## Tutorial Authoring Format

`tutorial.json`:

~~~json
{
  "title": "Your Tutorial Title",
  "steps": [
    {
      "title": "Step Title",
      "content": "<p>HTML instructions — supports full HTML</p>",
      "checkpoint": "circuits/filename.dig"
    }
  ]
}
~~~

URL params: `tutorial.html?tutorial=my-tutorial.json&step=3`

## Test Workflow

1. `python3 -m http.server 8080` from repo root
2. Open `http://localhost:8080/test-bridge.html`
3. **Tutorial/GUI tab:** Click "Launch Digital", wait for "READY" in log, then test checkpoint loading
4. **Headless tab:** Select a circuit, click "Run Headless", check log for output values / test results
5. Open `http://localhost:8080/tutorial.html` for the full tutorial experience
