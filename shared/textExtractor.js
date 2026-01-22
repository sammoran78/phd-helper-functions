const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

async function extractTextFromBuffer(buffer, fileType) {
    try {
        if (fileType === 'pdf' || fileType === 'application/pdf') {
            const data = await pdfParse(buffer);
            return data.text;
        } else if (fileType === 'docx' || fileType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const result = await mammoth.extractRawText({ buffer: buffer });
            return result.value;
        } else {
            throw new Error('Unsupported file type for text extraction');
        }
    } catch (error) {
        console.error('Text extraction failed:', error);
        throw new Error('Failed to extract text from file');
    }
}

module.exports = {
    extractTextFromBuffer
};
