/** Preserve a common multiline Python reproduction without making the Coordinator repair a wire-format constraint. */
export function missionValidationCommand(command: string): string {
  if (!/[\r\n]/u.test(command)) return command;
  const heredoc = /^([^\r\n]*\bpython(?:\d(?:\.\d+)?)?)\s+-\s+<<\s*(['"])([A-Za-z_]\w*)\2\r?\n([\s\S]*)\r?\n\3\s*$/u.exec(command);
  if (!heredoc) throw new Error("mission-validation-command: use an exact one-line shell command or a quoted Python heredoc");
  const expression = `exec(${JSON.stringify(heredoc[4])})`;
  return `${heredoc[1]} -c '${expression.replaceAll("'", "'\\''")}'`;
}
