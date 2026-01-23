# Worklog

A simple experimental issue tracker for AI agents. This is a lightweight worklog system similar to an issue tracker, designed to track a hierarchy of work items with basic fields.

## Features

- **API**: REST API built with Express
- **CLI**: Command-line interface for quick operations
- **TUI**: Terminal User Interface for interactive use
- **Git-Friendly**: Data stored in JSONL format for easy Git syncing
- **In-Memory Database**: Fast runtime performance
- **Hierarchical Work Items**: Support for parent-child relationships

## Installation

```bash
npm install
```

## Usage

### CLI

The CLI tool allows you to manage work items from the command line:

```bash
# Create a new work item
npm run cli -- create -t "My first task" -d "Description here" -s open -p high

# List all work items
npm run cli -- list

# List with filters
npm run cli -- list -s open -p high

# Show a specific work item
npm run cli -- show WI-1

# Show with children
npm run cli -- show WI-1 -c

# Update a work item
npm run cli -- update WI-1 -s in-progress

# Delete a work item
npm run cli -- delete WI-1

# Export data
npm run cli -- export -f backup.jsonl

# Import data
npm run cli -- import -f backup.jsonl
```

### API Server (Optional)

**Note:** You only need to start the API server if you want to interact with Worklog via REST API. The CLI and TUI work independently without requiring the API server.

Start the API server:

```bash
npm start
```

The server will run on `http://localhost:3000` by default. It automatically loads data from `worklog-data.jsonl` if it exists.

#### API Endpoints

- `GET /health` - Health check
- `POST /items` - Create a work item
- `GET /items` - List work items (with optional filters)
- `GET /items/:id` - Get a specific work item
- `PUT /items/:id` - Update a work item
- `DELETE /items/:id` - Delete a work item
- `GET /items/:id/children` - Get children of a work item
- `GET /items/:id/descendants` - Get all descendants
- `POST /export` - Export data to JSONL
- `POST /import` - Import data from JSONL

### TUI (Terminal User Interface)

Launch the interactive terminal UI:

```bash
npm run tui
```

**Controls:**
- `↑/↓` or `j/k` - Navigate through items
- `Enter` - View item details
- `n` - Create new item
- `d` - Delete selected item
- `u` - Update status of selected item
- `q` or `Ctrl+C` - Quit

## Data Format

Work items are stored in JSONL (JSON Lines) format, with each line representing one work item. This format is Git-friendly as changes to individual items create minimal diffs.

### Work Item Structure

```json
{
  "id": "WI-1",
  "title": "Example task",
  "description": "Task description",
  "status": "open",
  "priority": "medium",
  "parentId": null,
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:00:00.000Z",
  "tags": ["feature", "backend"]
}
```

### Fields

- **id**: Unique identifier (auto-generated)
- **title**: Short title of the work item
- **description**: Detailed description
- **status**: `open`, `in-progress`, `completed`, or `blocked`
- **priority**: `low`, `medium`, `high`, or `critical`
- **parentId**: ID of parent work item (null for root items)
- **createdAt**: ISO timestamp of creation
- **updatedAt**: ISO timestamp of last update
- **tags**: Array of string tags

## Development

Build the project:

```bash
npm run build
```

Run in development mode with auto-reload:

```bash
npm run dev
```

## Git Workflow

The system is optimized for Git-based workflows:

1. Make changes using the CLI, TUI, or API
2. Data is automatically saved to `worklog-data.jsonl`
3. Commit the JSONL file to Git
4. Share with your team through Git push/pull
5. The JSONL format minimizes merge conflicts

## License

MIT
