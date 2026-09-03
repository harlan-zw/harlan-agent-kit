import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultAgentContextPaths, instructionFilesLine, listInstructionFiles, loadAgentContext, opencodeAgentEnvironment } from '../src/agent-context.ts'

describe('defaultAgentContextPaths', () => {
  it('resolves the copied service context from its working directory', () => {
    expect(defaultAgentContextPaths({ CODEX_HOME: '/agent-home' }, '/service')).toEqual({
      instructionsPath: '/agent-home/AGENTS.md',
      skillsRoot: '/service/harlan-agent-kit/skills',
    })
  })
})

describe('loadAgentContext', () => {
  it('loads the global instructions and every installed Harlan skill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harlan-agent-context-'))
    const instructionsPath = join(root, 'AGENTS.md')
    const skillsRoot = join(root, 'skills')
    await writeFile(instructionsPath, '# Global instructions\n')
    await Promise.all(['pr', 'unit-tests'].map(async (name) => {
      const directory = join(skillsRoot, name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill.\n---\n`)
    }))

    try {
      await expect(loadAgentContext({ instructionsPath, skillsRoot })).resolves.toEqual({
        _tag: 'Ok',
        value: {
          instructionPaths: [instructionsPath],
          skillDirectories: [join(skillsRoot, 'pr'), join(skillsRoot, 'unit-tests')],
        },
      })
    }
    finally {
      await rm(root, { recursive: true })
    }
  })

  it('refuses to run without the global instructions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harlan-agent-context-'))

    try {
      await expect(loadAgentContext({
        instructionsPath: join(root, 'missing.md'),
        skillsRoot: join(root, 'skills'),
      })).resolves.toEqual({
        _tag: 'Err',
        error: `The global Agent instructions do not exist: ${join(root, 'missing.md')}`,
      })
    }
    finally {
      await rm(root, { recursive: true })
    }
  })
})

describe('opencodeAgentEnvironment', () => {
  it('keeps the standard OpenCode install reachable with a restricted service PATH', () => {
    const result = opencodeAgentEnvironment({
      context: { instructionPaths: ['/global/AGENTS.md'], skillDirectories: ['/skills/pr'] },
      environment: { HOME: '/agent-home', PATH: '/usr/bin:/bin' },
    })

    expect(result._tag).toBe('Ok')
    if (result._tag === 'Err')
      return
    expect(result.value.PATH).toBe('/agent-home/.opencode/bin:/usr/bin:/bin')
  })

  it('adds global instructions and every skill without dropping existing configuration', () => {
    const result = opencodeAgentEnvironment({
      context: {
        instructionPaths: ['/home/harlan/.codex/AGENTS.md'],
        skillDirectories: ['/kit/skills/pr', '/kit/skills/unit-tests'],
      },
      environment: {
        HOME: '/agent-home',
        PATH: '/bin',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          instructions: ['/repo/CONTRIBUTING.md'],
          share: 'disabled',
          skills: { paths: ['/custom/skill'], urls: ['https://example.com/skills/'] },
        }),
      },
    })

    expect(result._tag).toBe('Ok')
    if (result._tag === 'Err')
      return
    expect(result.value.PATH).toBe('/agent-home/.opencode/bin:/bin')
    expect(JSON.parse(result.value.OPENCODE_CONFIG_CONTENT ?? '')).toEqual({
      instructions: ['/repo/CONTRIBUTING.md', '/home/harlan/.codex/AGENTS.md'],
      share: 'disabled',
      skills: {
        paths: ['/custom/skill', '/kit/skills/pr', '/kit/skills/unit-tests'],
        urls: ['https://example.com/skills/'],
      },
    })
  })

  it('rejects malformed existing OpenCode configuration', () => {
    expect(opencodeAgentEnvironment({
      context: { instructionPaths: ['/global/AGENTS.md'], skillDirectories: ['/skills/pr'] },
      environment: { OPENCODE_CONFIG_CONTENT: '{' },
    })).toEqual({
      _tag: 'Err',
      error: 'OPENCODE_CONFIG_CONTENT must contain one JSON object.',
    })
  })
})

describe('instructionFilesLine', () => {
  it('names only the instruction files that exist, in canonical order', () => {
    expect(instructionFilesLine(['CLAUDE.md', 'AGENTS.md', 'README.md']))
      .toBe('Read these repository instruction files before you change code: AGENTS.md, CLAUDE.md.')
  })

  it('tells the Agent not to search when no instruction file exists', () => {
    expect(instructionFilesLine([]))
      .toBe('This repository has no AGENTS.md, CLAUDE.md, .github/copilot-instructions.md. Do not search for one.')
  })
})

describe('listInstructionFiles', () => {
  it('reports the instruction files present in one worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harlan-instruction-files-'))
    await mkdir(join(root, '.github'), { recursive: true })
    await writeFile(join(root, '.github', 'copilot-instructions.md'), '# Copilot\n')
    await mkdir(join(root, 'AGENTS.md'))

    try {
      await expect(listInstructionFiles(root)).resolves.toEqual(['.github/copilot-instructions.md'])
    }
    finally {
      await rm(root, { recursive: true })
    }
  })

  it('reports nothing for a worktree that does not exist', async () => {
    await expect(listInstructionFiles(join(tmpdir(), 'harlan-missing-worktree'))).resolves.toEqual([])
  })
})
