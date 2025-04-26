const fs = require('fs').promises;
const path = require('path');
const pdf = require('pdf-parse'); // Import pdf-parse
const mammoth = require('mammoth'); // Import mammoth

// Define supported text extensions (add more as needed)
const SUPPORTED_TEXT_EXTENSIONS = [
    '.txt', '.md', '.js', '.jsx', '.ts', '.tsx', '.py', '.html', '.css', '.json', '.csv', '.log', '.sh', '.bat' 
    // Note: These are handled by FileReader in renderer now, but keep for reference or potential backend-only paths
];

/**
 * Extracts text content from a given file path.
 * Currently supports common text files, DOCX (as Markdown), and PDF.
 * 
 * @param {string} filePath Absolute path to the file.
 * @returns {Promise<string>} A promise that resolves with the extracted text content.
 * @throws {Error} If the file type is unsupported or extraction fails.
 */
async function extractTextFromFile(filePath) {
    if (!filePath) {
        throw new Error('File path is required.');
    }

    console.log(`[File Extractor] Attempting to extract text from: ${filePath}`);
    const extension = path.extname(filePath).toLowerCase();

    try {
        // --- Plain Text Extraction ---
        if (SUPPORTED_TEXT_EXTENSIONS.includes(extension)) {
            const content = await fs.readFile(filePath, { encoding: 'utf-8' });
            console.log(`[File Extractor] Successfully read text file: ${filePath}`);
            return content;
        }

        // --- DOCX Extraction (as Markdown) ---
        else if (extension === '.docx') {
            console.log(`[File Extractor] Attempting DOCX extraction for: ${filePath}`);
            const result = await mammoth.convertToMarkdown({ path: filePath });
            console.log(`[File Extractor] Successfully extracted DOCX as Markdown: ${filePath}`);
            return result.value; // The extracted Markdown text
            // Messages from the conversion (e.g., unsupported features) are in result.messages
        }

        // --- PDF Extraction ---
        else if (extension === '.pdf') {
            console.log(`[File Extractor] Attempting PDF extraction for: ${filePath}`);
            const dataBuffer = await fs.readFile(filePath);
            const data = await pdf(dataBuffer);
            // data contains properties like numpages, numrender, info, metadata, version, text
            console.log(`[File Extractor] Successfully extracted PDF text (${data.numpages} pages): ${filePath}`);
            return data.text; // Return the extracted text content
        }
        
        else {
            console.warn(`[File Extractor] Unsupported file type: ${extension} for path: ${filePath}`);
            throw new Error(`Unsupported file type: ${extension}`);
        }
    } catch (error) {
        console.error(`[File Extractor] Error processing file ${filePath}:`, error);
        // Re-throw a more specific error or return null/empty string?
        // Throwing for now to indicate failure clearly.
        throw new Error(`Failed to extract text from ${path.basename(filePath)}: ${error.message}`);
    }
}

module.exports = {
    extractTextFromFile
}; 