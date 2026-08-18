/**
 * True when the arguments name one of this command's subcommands.
 *
 * citty runs the parent command after it runs a subcommand, so the parent has
 * to know it has nothing left to do. Without this, `sweep-worktrees` also
 * started the whole service and tried to bind the dashboard port.
 *
 * Only the first argument counts. A subcommand name that arrives later belongs
 * to an option, such as a configuration path.
 */
export function invokesSubCommand(rawArgs: readonly string[], names: readonly string[]): boolean {
  const first = rawArgs[0]
  return first !== undefined && names.includes(first)
}
