/**
 * True when the arguments name one of this command's subcommands.
 *
 * citty runs the parent command after it runs a subcommand, so the parent has
 * to know it has nothing left to do. Without this, `sweep-worktrees` also
 * started the whole service and tried to bind the dashboard port.
 *
 * citty dispatches on the first positional argument, so an option before the
 * subcommand name must not hide it. A name that arrives as an option value,
 * such as a configuration path, is not a subcommand. That needs the value
 * flags of the command, so pass its argument definitions.
 */
interface ArgumentDefinition {
  type?: 'string' | 'boolean' | 'enum' | 'positional'
  alias?: string | readonly string[]
}

interface ArgumentDefinitions {
  readonly [key: string]: ArgumentDefinition
}

function camelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

function flagTakesValue(flag: string, definitions: ArgumentDefinitions): boolean {
  const name = flag.replace(/^-{1,2}/, '')
  for (const [key, definition] of Object.entries(definitions)) {
    if (definition.type !== 'string' && definition.type !== 'enum')
      continue
    if (key === name || camelCase(key) === camelCase(name))
      return true
    const aliases = definition.alias === undefined ? [] : Array.isArray(definition.alias) ? definition.alias : [definition.alias]
    if (aliases.includes(name))
      return true
  }
  return false
}

export function invokesSubCommand(rawArgs: readonly string[], names: readonly string[], definitions: ArgumentDefinitions): boolean {
  for (let index = 0; index < rawArgs.length; index++) {
    const argument = rawArgs[index]
    if (argument === undefined)
      return false
    if (argument === '--')
      return false
    if (argument.startsWith('-')) {
      const value = rawArgs[index + 1]
      if (!argument.includes('=') && value !== undefined && flagTakesValue(argument, definitions))
        index += 1
      continue
    }
    return names.includes(argument)
  }
  return false
}
