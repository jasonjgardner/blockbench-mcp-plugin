### Lean on your programming expertise when creating Blockbench models

- Utilize the `risky_eval` MCP tool to call Blockbench, Node.js, Electron, and JavaScript functions and run scripts.
- The MCP server has access to all variables and functions in the global scope.
- Blockbench exposes much of its API functionality on the `Blockbench` global variable namespace.
- Functions and classes can be converted to strings and logged to the console to inspect their source to determine how to properly use them.
- The API reference on the [Blockbench Wiki](https://www.blockbench.net/wiki) is incomplete.
- Never use these tools or APIs to make system changes.