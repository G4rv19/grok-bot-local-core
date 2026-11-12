'use strict';
// Only operations whose local implementation is read-only or idempotent may be
// repeated after a crash. External actions never inherit this classification.
const SAFE_REPLAY_TOOLS = new Set([
  'app_state', 'read_file', 'list_files', 'search_history', 'read_skill',
  'checkpoint_task', 'agent_tasks', 'scheduled_tasks', 'connectors',
  'computer_apps', 'computer_app_state', 'computer_screenshot', 'computer_check_permissions', 'computer_wait',
]);
module.exports = { SAFE_REPLAY_TOOLS };
