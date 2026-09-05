import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeProjectSlug, defaultAgentContextPaths, findRepositoryMemory, instructionFilesLine, listInstructionFiles, loadAgentContext, opencodeAgentEnvironment, opencodeTurnEnvironment, repositoryMemoryIndexPath, repositoryMemoryLine } from '../src/agent-context.ts'

describe('defaultAgentContextPaths', () => {
  it('resolves the copied service context from its working directory', () => {
    expect(defaultAgentContextPaths({ CODEX_HOME: '/agent-home', HOME: '/agent-home' }, '/service')).toEqual({
      claudeHome: '/agent-home/.claude',
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
      await expect(loadAgentContext({ claudeHome: join(root, '.claude'), instructionsPath, skillsRoot })).resolves.toEqual({
        _tag: 'Ok',
        value: {
          claudeHome: join(root, '.claude'),
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
        claudeHome: join(root, '.claude'),
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
      context: { claudeHome: '/agent-home/.claude', instructionPaths: ['/global/AGENTS.md'], skillDirectories: ['/skills/pr'] },
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
        claudeHome: '/home/harlan/.claude',
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
      context: { claudeHome: '/agent-home/.claude', instructionPaths: ['/global/AGENTS.md'], skillDirectories: ['/skills/pr'] },
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

describe('claudeProjectSlug', () => {
  it('names the project directory Claude Code writes for a real checkout', () => {
    expect(claudeProjectSlug('/home/harlan/pkg/harlan-agent-kit'))
      .toEqual({ _tag: 'Ok', value: '-home-harlan-pkg-harlan-agent-kit' })
  })

  it('turns every dot in a site checkout into one hyphen', () => {
    expect(claudeProjectSlug('/home/harlan/sites/gscdump.com'))
      .toEqual({ _tag: 'Ok', value: '-home-harlan-sites-gscdump-com' })
    expect(claudeProjectSlug('/home/harlan/sites/scripts.nuxt.com'))
      .toEqual({ _tag: 'Ok', value: '-home-harlan-sites-scripts-nuxt-com' })
  })

  it('doubles the hyphen for a hidden directory', () => {
    expect(claudeProjectSlug('/home/harlan/.claude/skills/vue-skilld/.skilld'))
      .toEqual({ _tag: 'Ok', value: '-home-harlan--claude-skills-vue-skilld--skilld' })
  })

  it('names a worktree sibling separately from its primary checkout', () => {
    expect(claudeProjectSlug('/home/harlan/pkg/nuxt-pr-36208-control.fix-pr-36208-layer-scan'))
      .toEqual({ _tag: 'Ok', value: '-home-harlan-pkg-nuxt-pr-36208-control-fix-pr-36208-layer-scan' })
  })

  it('refuses a relative path', () => {
    expect(claudeProjectSlug('pkg/harlan-agent-kit'))
      .toEqual({ _tag: 'Err', error: 'The checkout path must be absolute.' })
  })

  it('refuses a path whose project name Claude Code shortens with a hash', () => {
    const result = claudeProjectSlug(`/home/harlan/pkg/${'a'.repeat(200)}`)

    expect(result._tag).toBe('Err')
  })
})

describe('repositoryMemoryIndexPath', () => {
  it('points at the index inside the project memory directory', () => {
    expect(repositoryMemoryIndexPath({
      claudeHome: '/home/harlan/.claude',
      checkoutPath: '/home/harlan/pkg/harlan-agent-kit',
    })).toEqual({
      _tag: 'Ok',
      value: '/home/harlan/.claude/projects/-home-harlan-pkg-harlan-agent-kit/memory/MEMORY.md',
    })
  })
})

describe('findRepositoryMemory', () => {
  it('names the index the desktop recorded for a primary checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harlan-agent-memory-'))
    const claudeHome = join(root, '.claude')
    const memory = join(claudeHome, 'projects', '-home-harlan-pkg-harlan-agent-kit', 'memory')
    await mkdir(memory, { recursive: true })
    await writeFile(join(memory, 'MEMORY.md'), '- [Deployment](deployment.md)\n')

    try {
      await expect(findRepositoryMemory({ claudeHome, checkoutPath: '/home/harlan/pkg/harlan-agent-kit' }))
        .resolves
        .toEqual({ indexPath: join(memory, 'MEMORY.md') })
    }
    finally {
      await rm(root, { recursive: true })
    }
  })

  it('answers null when the repository has no memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harlan-agent-memory-'))

    try {
      await expect(findRepositoryMemory({ claudeHome: join(root, '.claude'), checkoutPath: '/home/harlan/pkg/unwritten' }))
        .resolves
        .toBeNull()
    }
    finally {
      await rm(root, { recursive: true })
    }
  })

  it('answers null for a worktree whose primary checkout holds the memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harlan-agent-memory-'))
    const claudeHome = join(root, '.claude')
    const memory = join(claudeHome, 'projects', '-home-harlan-pkg-harlan-agent-kit', 'memory')
    await mkdir(memory, { recursive: true })
    await writeFile(join(memory, 'MEMORY.md'), '- [Deployment](deployment.md)\n')

    try {
      await expect(findRepositoryMemory({ claudeHome, checkoutPath: '/home/harlan/pkg/harlan-agent-kit.feat-thing' }))
        .resolves
        .toBeNull()
    }
    finally {
      await rm(root, { recursive: true })
    }
  })
})

describe('repositoryMemoryLine', () => {
  it('says nothing when the repository has no memory', () => {
    expect(repositoryMemoryLine(null)).toBe('')
  })

  it('names the index, the sibling files, and the age of what it records', () => {
    const line = repositoryMemoryLine({ indexPath: '/home/harlan/.claude/projects/-home-harlan-pkg-unhead/memory/MEMORY.md' })

    expect(line).toContain('/home/harlan/.claude/projects/-home-harlan-pkg-unhead/memory/MEMORY.md')
    expect(line).toContain('links to a sibling file in the same directory by name')
    expect(line).toContain('Check it against the code before you rely on it.')
  })
})

describe('opencodeTurnEnvironment', () => {
  it('adds one turn instruction file without dropping the shared context', () => {
    const result = opencodeTurnEnvironment({
      environment: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          instructions: ['/home/harlan/.codex/AGENTS.md'],
          skills: { paths: ['/kit/skills/pr'] },
        }),
      },
      instructionPaths: ['/home/harlan/.claude/projects/-home-harlan-pkg-unhead/memory/MEMORY.md'],
    })

    expect(result._tag).toBe('Ok')
    if (result._tag === 'Err')
      return
    expect(JSON.parse(result.value.OPENCODE_CONFIG_CONTENT ?? '')).toEqual({
      instructions: [
        '/home/harlan/.codex/AGENTS.md',
        '/home/harlan/.claude/projects/-home-harlan-pkg-unhead/memory/MEMORY.md',
      ],
      skills: { paths: ['/kit/skills/pr'] },
    })
  })

  it('answers the same environment when the turn adds nothing', () => {
    const environment = { OPENCODE_CONFIG_CONTENT: '{"instructions":["/a.md"]}' }

    expect(opencodeTurnEnvironment({ environment, instructionPaths: [] }))
      .toEqual({ _tag: 'Ok', value: environment })
  })

  it('rejects malformed existing OpenCode configuration', () => {
    expect(opencodeTurnEnvironment({
      environment: { OPENCODE_CONFIG_CONTENT: '{' },
      instructionPaths: ['/memory/MEMORY.md'],
    })).toEqual({
      _tag: 'Err',
      error: 'OPENCODE_CONFIG_CONTENT must contain one JSON object.',
    })
  })
})
