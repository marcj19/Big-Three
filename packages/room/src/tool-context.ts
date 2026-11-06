import path from 'node:path';

/** A bounded display hint. Raw commands, arguments and tool output stay out of the journal. */
export function toolContext(name: string, input: unknown, cwd: string): string | undefined {
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (/(?:^|[._])(?:bash|powershell|terminal|shell|exec_command|run_command)$/i.test(name)) {
    const command = typeof input === 'string' ? input : args.command ?? args.CommandLine ?? args.command_line;
    if (typeof command !== 'string') return;
    const shell = command.trim().replace(/^(?:"[^"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?\s+[^;&|]{0,80}?-(?:command|c)\s+["']?/i, '');
    return /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|dev|test|lint|typecheck|check|install|ci)|git\s+(?:status|diff|log|show|ls-files|rev-parse)|rg|Get-Content|Get-ChildItem|Select-String|pytest|dotnet\s+(?:build|test)|cargo\s+(?:build|test|check))\b/i.exec(shell)?.[0].replace(/\s+/g, ' ');
  }
  if (!/(?:read|view|open|write|edit|replace|list|glob|grep|search|patch|file|directory)/i.test(name)) return;
  const target = args.file_path ?? args.filePath ?? args.FilePath ?? args.AbsolutePath ?? args.TargetFile ?? args.Path ?? args.path ?? args.DirectoryPath;
  if (typeof target !== 'string' || /[\x00-\x1f\x7f]/.test(target)) return;
  const relative = path.relative(cwd, path.resolve(cwd, target));
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return;
  return relative.split(path.sep).join('/').slice(0, 180);
}
