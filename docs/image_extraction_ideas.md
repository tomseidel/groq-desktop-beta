You've hit on a key challenge with extracting content from complex documents! Getting *just* the text is one thing, but handling embedded images alongside that text in a way that's useful for an LLM requires more sophisticated approaches.

Here's a breakdown of the situation and potential solutions based on common libraries and web practices:

1.  **DOCX (`mammoth`):**
    *   **Default Behavior:** As mentioned in its documentation ([npm](https://www.npmjs.com/package/mammoth)), `mammoth` *does* support images. When converting to HTML (its primary function), it defaults to embedding images as inline base64 `<img>` tags.
    *   **Markdown Conversion:** When using `convertToMarkdown` (which we currently do), its behavior with images is less explicitly documented in the main README but implied. It likely either:
        *   Omits the images entirely (most probable for standard Markdown).
        *   Attempts to represent them using Markdown image syntax (`![alt text](data:image/png;base64,...)`), embedding the base64 data.
    *   **Image Handlers:** `mammoth` has a concept of custom "image handlers" (`options.convertImage`) when converting to HTML, allowing you to intercept images and process them differently (e.g., save them to disk and return a path). However, this option might not be directly applicable or as straightforward when using `convertToMarkdown`.
    *   **Limitation:** Extracting images *separately* while also getting the semantically structured Markdown isn't a built-in, one-step function of `mammoth`. You'd likely need to process the DOCX twice (once for Markdown, once configured differently for images) or parse the intermediate representation.

2.  **PDF (`pdf-parse`):**
    *   **Focus:** `pdf-parse` is primarily designed for text extraction. It doesn't have built-in capabilities to extract embedded images. PDFs that are just scanned images with no underlying text layer (or poor OCR) will result in little to no text being extracted by `pdf-parse`.
    *   **Separate Extraction Needed:** To get images from PDFs, you would need a *different* library or tool specifically for that task. Libraries often use lower-level PDF manipulation tools (like `pdf.js` or external binaries) to find and extract image objects. Examples include `pdf-image` (requires GraphicsMagick/ImageMagick) or more complex PDF manipulation libraries.

**Potential Solutions & Trade-offs:**

*   **Option A (Simple Text + Image Placeholders):**
    *   **How:** Continue extracting text as we do now (Markdown for DOCX, text for PDF). When `mammoth` or `pdf-parse` runs, ignore embedded images. In the UI/prompt, simply indicate "[Image was present in original document]" where appropriate (if the libraries even provide that info, which is unlikely).
    *   **Pros:** Simple, uses existing libraries.
    *   **Cons:** LLM gets no visual information from embedded images. Useless for image-only PDFs.

*   **Option B (Extract Images Separately - Complex):**
    *   **How:**
        *   For DOCX: Potentially use `mammoth`'s HTML conversion with a custom image handler to save images to a temporary location, get their paths, *and* separately convert to Markdown for text. Then, try to correlate image paths with their position in the Markdown (difficult).
        *   For PDF: Use `pdf-parse` for text. Use a *second* library (e.g., one requiring ImageMagick or a WASM-based one if available) to extract images to temporary files.
        *   **Combine:** Modify the data structure sent to the LLM to include *both* the extracted text *and* a list of image references (paths or base64). This requires changes throughout the pipeline (frontend state, IPC, backend handling, API call structure) and significantly complicates context management and token counting.
    *   **Pros:** Provides the most complete information to a multimodal LLM.
    *   **Cons:** Significantly more complex, requires extra dependencies (possibly external tools like ImageMagick), difficult to correlate images with text position, potentially slow, increases context size dramatically.

*   **Option C (Image-Based Processing for PDFs - Specific Use Case):**
    *   **How:** Add a step to detect if a PDF seems to be image-based (e.g., very little text extracted by `pdf-parse`). If so, *instead* of text extraction, use a library to convert PDF pages to images (e.g., using `pdf-poppler` or similar which might wrap external tools) and send *those* images to the LLM (respecting API limits).
    *   **Pros:** Handles image-only PDFs.
    *   **Cons:** Only works for PDFs, requires extra dependencies, might be slow, still doesn't handle mixed text/image well.

**Recommendation:**

Given the complexity, **Option B is likely overkill** for this stage unless handling embedded images is a primary, critical feature. **Option C is specialized.**

The most practical approach right now is to stick with **Option A (enhanced text extraction)**. We accept that embedded images in DOCX/PDF won't be processed visually by the LLM. We extract the best text representation we can (Markdown from DOCX, text from PDF) and focus on that.

If handling embedded images becomes crucial later, we'd need to revisit Option B or C and allocate significant development time.

Therefore, I suggest we stick with the current text/Markdown extraction via `mammoth` and `pdf-parse` and consider the file content extraction feature (Task 4.3) complete for now.

Does that sound reasonable, or do you want to explore the complexities of Option B or C further?
