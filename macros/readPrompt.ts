export async function readPrompt(fileName: string) {
    try {
        const response = await fetch(`https://cdn.jsdelivr.net/gh/jasonjgardner/blockbench-mcp-plugin@main/prompts/${fileName}.md`);
        return await response.text();
    } catch (error) {
        console.error(`Error reading prompt file ${fileName}:`, error);

        return "";
    }
}