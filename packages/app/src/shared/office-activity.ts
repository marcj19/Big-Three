export type Activity = 'thinking' | 'writing' | 'tool' | 'reading' | 'editing' | 'terminal' | 'searching' | 'database' | 'consulting' | 'reviewing' | 'done' | 'error' | 'cancelled' | 'limited';

/** Describes only the observed tool name. */
export function toolActivity(name: string): Activity {
  const tool = name.toLowerCase();
  if (/ask_peer/.test(tool)) return 'consulting';
  if (/query|sql|schema|database|list_tables/.test(tool)) return 'database';
  if (/apply_patch|write_file|edit_file|multiedit|(^|__|\.)edit$|(^|__|\.)write$/.test(tool)) return 'editing';
  if (/web.?search|web.?fetch|search|grep|glob/.test(tool)) return 'searching';
  if (/read_file|read_room|(^|__|\.)read$|open_file|view_file|list_directory/.test(tool)) return 'reading';
  if (/exec_command|shell|terminal|bash|powershell|run_command/.test(tool)) return 'terminal';
  return 'tool';
}
