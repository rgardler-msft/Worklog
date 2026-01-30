# OpenCode TUI Integration Documentation

## Overview

The Worklog TUI now includes full integration with OpenCode, an AI-powered coding assistant. This integration allows you to interact with OpenCode directly from the TUI, with support for real-time streaming responses, session persistence, and interactive user input.

## Features

### 1. Quick Access

- Press `o` or `O` from anywhere in the TUI to open the OpenCode dialog
- The dialog provides a text area for entering prompts and commands

### 2. Auto-start Server

- The OpenCode server automatically starts when you open the dialog
- Server status is displayed in the dialog header:
  - `[-]` - Server stopped
  - `[~]` - Server starting
  - `[OK] Port: 51625` - Server running
  - `[X]` - Server error
- Default port: 9999 (configurable via `OPENCODE_SERVER_PORT` environment variable)

### 3. Slash Command Autocomplete

- Type `/` to see available slash commands
- 28 commands available including:
  - `/help` - Get help
  - `/edit` - Edit files
  - `/create` - Create new files
  - `/test` - Run tests
  - `/fix` - Fix issues
  - And many more...
- Autocomplete suggestions appear below the input with an arrow indicator (↳)
- Press Enter to accept the suggestion

### 4. Session Management

- Sessions persist across multiple prompts
- Each TUI session maintains its own OpenCode conversation context
- Session ID is displayed at the start of each response

### 5. Real-time Streaming

- Responses stream in real-time using Server-Sent Events (SSE)
- See text as it's generated
- Tool usage is highlighted in yellow
- Tool results shown in green

### 6. Interactive Input

- When OpenCode needs user input, an input field appears automatically
- Input types are clearly labeled:
  - "Yes/No Input" for boolean questions
  - "Password Input" for sensitive data
  - "Input Required" for general text
- User responses are shown in cyan in the conversation
- Press Escape to cancel input mode

## Usage

### Starting a Conversation

1. Press `o` to open the OpenCode dialog
2. Wait for the server status to show `[OK]` (server health uses `/global/health`)
3. Type your prompt or slash command
4. Press `Ctrl+S` to send (or click the Send button)
5. The response will appear in a pane at the bottom of the screen

### Navigation

- **In the dialog:**
   - `Ctrl+S` - Send prompt
   - `Enter` - Accept autocomplete or add newline
   - `Escape` - Close dialog

- **In the response pane:**
  - Arrow keys or vim keys (`j`/`k`) - Scroll through response
  - `q` or `Escape` - Close pane
  - Click `[x]` in top-right to close

- **When input is required:**
  - Type your response
  - `Enter` - Submit input
  - `Escape` - Cancel input

### Examples

#### Simple Question

```
What is the purpose of this repository?
```

#### Using Slash Commands

```
/edit src/commands/tui.ts
Add a comment explaining the openOpencodeDialog function
```

#### Multi-line Prompts

```
Review the following code and suggest improvements:
[paste code]

Focus on performance and readability.
```

## Configuration

### Environment Variables

- `OPENCODE_SERVER_PORT` - Override the default server port (9999)

Note: Worklog’s OpenCode client does not currently attach auth headers, so enabling OpenCode server auth will likely prevent the TUI from connecting.

### Server Management

The server is managed automatically, but you can also:

- Start manually: `opencode serve --port $OPENCODE_SERVER_PORT`
- Check if running: `lsof -i :$OPENCODE_SERVER_PORT`
- View server API docs: `http://localhost:$OPENCODE_SERVER_PORT/doc`

## Technical Details

### API Communication

- Uses OpenCode's HTTP API for session and message management
- Endpoints used:
  - `POST /session` - Create new session
  - `POST /session/{id}/prompt_async` - Send prompts
  - `GET /event` - SSE stream for responses
  - `POST /session/{id}/input` - Send user input

### Error Handling

- Server starts automatically when opening dialog (API-only mode)
- Connection errors displayed in red
- Graceful degradation for network issues

### File Locations

- Main implementation: `src/commands/tui.ts`
- Server management: Lines 591-698
- OpenCode dialog: Lines 383-397
- SSE streaming: Lines 734-896
- Input handling: Lines 858-927

## Troubleshooting

### Server Won't Start

- Check if port 51625 is already in use: `lsof -i :51625`
- Try a different port: `export OPENCODE_SERVER_PORT=4096`
- Ensure OpenCode is installed: `which opencode`

### No Response

- Check server status indicator in dialog header
- Verify server is running: `ps aux | grep "opencode serve"`
- Check for errors in response pane

### Input Not Working

- Ensure the input field is focused (green border)
- Check that server connection is active
- Try reopening the OpenCode dialog

### Session Lost

- Sessions are maintained per TUI instance
- Restarting TUI will create a new session
- Previous conversations are not persisted to disk

## Development

### Testing

```bash
# Run the test script
./test-tui.sh

# Test input simulation
./test-input.sh
```

### Building

```bash
npm run build
npm test
```

### Debugging

- Server logs: The server runs with stdio inherited
- Check response pane for error messages
- Use `curl` to test server endpoints directly

## Future Enhancements

Planned improvements include:

- Session history and persistence
- Multiple concurrent sessions
- File upload support
- Custom themes for responses
- Export conversation to markdown
- Integration with work item context

## Related Work Items

- WL-0MKW7SLB30BFCL5O - Epic: OpenCode server + interactive 'O' pane
- WL-0MKW1GUSC1DSWYGS - Slash command autocomplete
- WL-0MKWCW9K610XPQ1P - Auto-start OpenCode server
- WL-0MKWCQQIW0ZP4A67 - Send prompts to server
- WL-0MKWE048418NPBKL - Enable user input for agents

---

For more information about OpenCode, visit: https://opencode.ai/docs/
