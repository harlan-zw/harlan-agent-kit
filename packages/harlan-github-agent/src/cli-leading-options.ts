/**
 * Move options from before the subcommand name to the end of the arguments.
 *
 * citty parses the whole argument list once per command level, so an option
 * before the subcommand name binds to the root command. The control
 * subcommand then read its default configuration file instead of the requested
 * one, and the parent command still started the whole agent service.
 *
 * Options with a separate value only swallow the next argument when the option
 * name declares a value. Returns the original arguments unchanged when the
 * first positional argument is not the subcommand.
 */
export function forwardLeadingOptions(
  rawArgs: readonly string[],
  valueOptionNames: readonly string[],
  subCommandName: string,
): string[] {
  const leading: string[] = []
  let index = 0
  let argument = rawArgs[index]
  while (argument !== undefined && argument.startsWith('-') && argument !== '--') {
    leading.push(argument)
    const nextArgument = rawArgs[index + 1]
    if (!argument.includes('=') && valueOptionNames.includes(argument) && nextArgument !== undefined && !nextArgument.startsWith('-')) {
      leading.push(nextArgument)
      index += 2
    }
    else {
      index += 1
    }
    argument = rawArgs[index]
  }
  const firstPositional = rawArgs[index]
  if (leading.length === 0 || firstPositional !== subCommandName)
    return [...rawArgs]
  return [...rawArgs.slice(index), ...leading]
}
