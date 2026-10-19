/** Fixed alpha.4 direct pre-step fixtures must provide the new required final assembly fact. */
import { createHash } from 'node:crypto'

const fixtures = [
  {
    "file": "packages/plan/plan-mode/tests/plan-mode.spec.ts",
    "beforeSha256": "883931fd80c3457f8dfe49ba0434203d670a166a1254647bf661e5d7975cfa84",
    "afterSha256": "73a51eaa636c71a888562d0f6266c08d376d4f0c4f0a6b0c535f4e6403f5946b",
    "payloadCount": 1,
    "replacements": [
      {
        "before": "{ messages: [message], turn: 1, step: 1, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [message], turn: 1, step: 1, signal }",
        "count": 1
      }
    ]
  },
  {
    "file": "scripts/python-snapshot-workflow-order.spec.ts",
    "beforeSha256": "3a7b437a36ccb2199bfbc8814a2f2f0450ff5480a295ee207e2e28cd5a108c3d",
    "afterSha256": "1af22da4cbbe0c6adeb2311776ad3d091f0c81aa83e0341c466a9565b605a9f0",
    "payloadCount": 1,
    "replacements": [
      {
        "before": "{\n    turn: 1, step: 1, messages, signal: controller.signal, ...overrides,\n  }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} },\n    turn: 1, step: 1, messages, signal: controller.signal, ...overrides,\n  }",
        "count": 1
      }
    ]
  },
  {
    "file": "packages/core/agent/tests/model-selection.spec.ts",
    "beforeSha256": "aae45297c7363b6131d813db6d54b7a8ae24b009c4a998f8514c7171755c3791",
    "afterSha256": "38d5deebb05a7b7c0b19307946cb253bcefec48f1ff89bb75bf9104bc5cbc52d",
    "payloadCount": 2,
    "replacements": [
      {
        "before": "import SystemPrompt from '@deepseek-ai/dsh-system-prompt'",
        "after": "import SystemPrompt, { type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'",
        "count": 1
      },
      {
        "before": "ctx.systemPrompt.assemble()",
        "after": "assemble(ctx)",
        "count": 9
      },
      {
        "before": "function createAgent(): Agent {",
        "after": "const assembledPrompts = new WeakMap<Context, PromptAssembly>()\nasync function assemble(ctx: Context): Promise<PromptAssembly> {\n  const assembly = await ctx.systemPrompt.assemble()\n  assembledPrompts.set(ctx, assembly)\n  return assembly\n}\nfunction capturedAssembly(ctx: Context): PromptAssembly {\n  const assembly = assembledPrompts.get(ctx)\n  if (assembly === undefined) throw new Error('model-selection fixture must assemble before pre-step')\n  return assembly\n}\n\nfunction createAgent(): Agent {",
        "count": 1
      },
      {
        "before": "{ turn: 1, step, messages: offered, signal }",
        "after": "{ assembly: capturedAssembly(ctx), turn: 1, step, messages: offered, signal }",
        "count": 1
      },
      {
        "before": "{ turn: 1, step: 1, messages: [], signal: SIGNAL }",
        "after": "{ assembly: capturedAssembly(ctx), turn: 1, step: 1, messages: [], signal: SIGNAL }",
        "count": 1
      }
    ]
  },
  {
    "file": "packages/api/session-controller/tests/archived-session-gate.host.spec.ts",
    "beforeSha256": "160da9215d28c8cd5fcdc67bcc498118196ababbae3baa5394785c80c3b5a91b",
    "afterSha256": "d8a81e1a33caea2faf7a75d580cb501173815b9260634ca07c498c84faa842e9",
    "payloadCount": 1,
    "replacements": [
      {
        "before": "{ agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal }",
        "count": 1
      }
    ]
  },
  {
    "file": "packages/context/tmux-context/tests/tmux-context.spec.ts",
    "beforeSha256": "fedd8a625ce8ed5e22378a0dfba32769188e88af2daa79ab6ee9c4580d9c2902",
    "afterSha256": "9da66dcfe3a409b4cfdd7bf1b01bb98b177783ec9538b86d42af387f6c239493",
    "payloadCount": 1,
    "replacements": [
      {
        "before": "{ messages: [], turn, step, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [], turn, step, signal }",
        "count": 1
      }
    ]
  },
  {
    "file": "packages/skill/tool-skill/tests/tool-skill.spec.ts",
    "beforeSha256": "c4d1bcee211ef11967f49c8545e84cabb2fe29c69261363a8a424f2f8b48369d",
    "afterSha256": "33b13f88f61b28b03e705e4295756bc8b180f0f88fbdd30f7eba07ddf56f1724",
    "payloadCount": 4,
    "replacements": [
      {
        "before": "{ messages: [], turn, step, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [], turn, step, signal }",
        "count": 1
      },
      {
        "before": "{ messages, turn: 1, step: 1, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages, turn: 1, step: 1, signal }",
        "count": 1
      },
      {
        "before": "{ messages: [], turn: 1, step: 1, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [], turn: 1, step: 1, signal }",
        "count": 1
      },
      {
        "before": "{ messages: [gesture('/hidden-demo blocked step')], turn: 1, step: 1, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [gesture('/hidden-demo blocked step')], turn: 1, step: 1, signal }",
        "count": 1
      }
    ]
  },
  {
    "file": "packages/context/time-context/tests/time-context.spec.ts",
    "beforeSha256": "8fe1362d2dd0035e8ef6a4d4a78d842b56167ab3b215727a7173e2d8ca525105",
    "afterSha256": "c7db7d3ae8c376c7ee41383445f93ec9b48c06d1000307b2b6668306ddeb9462",
    "payloadCount": 1,
    "replacements": [
      {
        "before": "{ messages: [proposed], turn, step, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [proposed], turn, step, signal }",
        "count": 1
      }
    ]
  },
  {
    "file": "packages/context/session-reference/tests/session-reference.spec.ts",
    "beforeSha256": "1aa4c92cb5ed79f63d7868dfa91a487006f9ef2964ef9866cb442b7f784b7c54",
    "afterSha256": "6317433ca276333a9f198b206a7953080a5f529af4f1a1920371cc37f30c8618",
    "payloadCount": 6,
    "replacements": [
      {
        "before": "{ messages: [direct], turn: 1, step: 1, signal: controller.signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [direct], turn: 1, step: 1, signal: controller.signal }",
        "count": 1
      },
      {
        "before": "{ messages: [message], turn: 1, step: 1, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [message], turn: 1, step: 1, signal }",
        "count": 1
      },
      {
        "before": "{ messages: [message], turn: 1, step: 1, signal: new AbortController().signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [message], turn: 1, step: 1, signal: new AbortController().signal }",
        "count": 1
      },
      {
        "before": "{ messages: [direct, ordinary, plugin], turn: 1, step: 1, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [direct, ordinary, plugin], turn: 1, step: 1, signal }",
        "count": 1
      },
      {
        "before": "{ messages: [malformed], turn: 1, step: 1, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [malformed], turn: 1, step: 1, signal }",
        "count": 2
      }
    ]
  },
  {
    "file": "packages/context/session-reference/tests/loader-composition.spec.ts",
    "beforeSha256": "58e6152863b41aed4aba05b32162b4048755ef10edccab898c6ade60f405fc1f",
    "afterSha256": "0263475a9396374ef8f271a6aafbdc03baa5b906c9ca6b98fcc82186b8588345",
    "payloadCount": 1,
    "replacements": [
      {
        "before": "{\n      messages: [direct], turn: 1, step: 1, signal: new AbortController().signal,\n    }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} },\n      messages: [direct], turn: 1, step: 1, signal: new AbortController().signal,\n    }",
        "count": 1
      }
    ]
  },
  {
    "file": "apps/cli/tests/fixtures/dsh-badge/snapshot.ts",
    "beforeSha256": "54337f2cbcadf535dbda9d0e933340f12dbbdc7521446d7fa1db5acff156508f",
    "afterSha256": "81c1a6e0bd0f08b28bc362f88557722dbf44ccb8b09d0d22d8490435b154466d",
    "payloadCount": 1,
    "replacements": [
      {
        "before": "{ messages: [], turn: 1, step: 1, signal: new AbortController().signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [], turn: 1, step: 1, signal: new AbortController().signal }",
        "count": 1
      }
    ]
  },
  {
    "file": "packages/context/agent-instructions/tests/agent-instructions.spec.ts",
    "beforeSha256": "385d79590d6fc905402218742e35d99a6da037d3caeed0f396cb0a95b66bb069",
    "afterSha256": "e9c0bacf7f82f4871b252435698203f0195eddb9efcd7784e3ec9d0746e71af5",
    "payloadCount": 15,
    "replacements": [
      {
        "before": "{ messages: [], turn: 1, step: 1, signal: testToolSignal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [], turn: 1, step: 1, signal: testToolSignal }",
        "count": 1
      },
      {
        "before": "{ messages: [], turn: 1, step: 1, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [], turn: 1, step: 1, signal }",
        "count": 1
      },
      {
        "before": "{ messages: claimed, turn: 1, step: 2, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: claimed, turn: 1, step: 2, signal }",
        "count": 1
      },
      {
        "before": "{ messages: [], turn: 1, step: 1, signal: AbortSignal.timeout(requestTimeoutMs) }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [], turn: 1, step: 1, signal: AbortSignal.timeout(requestTimeoutMs) }",
        "count": 4
      },
      {
        "before": "{ messages: claimed, turn: 1, step: 1, signal: AbortSignal.timeout(requestTimeoutMs) }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: claimed, turn: 1, step: 1, signal: AbortSignal.timeout(requestTimeoutMs) }",
        "count": 2
      },
      {
        "before": "{ messages: staleClaim, turn: 1, step: 1, signal: AbortSignal.timeout(requestTimeoutMs) }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: staleClaim, turn: 1, step: 1, signal: AbortSignal.timeout(requestTimeoutMs) }",
        "count": 1
      },
      {
        "before": "{ messages: [prompt], turn: 1, step: 1, signal: AbortSignal.timeout(requestTimeoutMs) }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [prompt], turn: 1, step: 1, signal: AbortSignal.timeout(requestTimeoutMs) }",
        "count": 1
      },
      {
        "before": "{ messages: [prompt], turn: 2, step: 1, signal: AbortSignal.timeout(requestTimeoutMs) }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [prompt], turn: 2, step: 1, signal: AbortSignal.timeout(requestTimeoutMs) }",
        "count": 1
      },
      {
        "before": "{ messages: [], turn: 1, step: 1, signal: controller.signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [], turn: 1, step: 1, signal: controller.signal }",
        "count": 2
      },
      {
        "before": "{ messages: claimed, turn: 1, step: 1, signal: testToolSignal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: claimed, turn: 1, step: 1, signal: testToolSignal }",
        "count": 1
      }
    ]
  },
  {
    "file": "packages/compaction/compaction-basic/tests/compaction-basic.spec.ts",
    "beforeSha256": "9de39a8931bd2bb85566a7c6083f91aea03fc9cbaa7e885e8a89cc004b566fe8",
    "afterSha256": "7c33dea21ceb37c76c4db7a715fbd69035104d430f6101749dfbb764a17806b9",
    "payloadCount": 1,
    "replacements": [
      {
        "before": "{ messages: [], turn: 1, step: 1, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [], turn: 1, step: 1, signal }",
        "count": 1
      }
    ]
  },
  {
    "file": "packages/subagent/tool-subagent/tests/model-selection-settings.spec.ts",
    "beforeSha256": "89876f3c11accb64526a50c475937210392e7514f04915760401a0867c513c1a",
    "afterSha256": "af0f5e7c6f68f59c00ba232c8ed6638ce38e67a90d9673b7088912b9cdb05107",
    "payloadCount": 1,
    "replacements": [
      {
        "before": "{\n      agent: enabled.agent,\n      messages: [],\n      turn: 1,\n      step: 1,\n      signal: new AbortController().signal,\n    }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} },\n      agent: enabled.agent,\n      messages: [],\n      turn: 1,\n      step: 1,\n      signal: new AbortController().signal,\n    }",
        "count": 1
      }
    ]
  },
  {
    "file": "packages/session/session-checkpoint-policy/tests/session-checkpoint-policy.spec.ts",
    "beforeSha256": "236cae5d427dd75737f972450c85240629380516b4cc1c702de9445ea0c59941",
    "afterSha256": "80557fa094089f65d93fbe3d90cb71967d950f385311720c46cf4ce37c9ad0e8",
    "payloadCount": 1,
    "replacements": [
      {
        "before": "{ messages: [], turn: 1, step: 1, signal }",
        "after": "{ assembly: { sections: [], contexts: [], tools: [], variables: {} }, messages: [], turn: 1, step: 1, signal }",
        "count": 1
      }
    ]
  }
]

const hash = source => createHash('sha256').update(source).digest('hex')
export const STUDIO_MODEL_SELECTION_FIXTURE_EDITS = fixtures.map(fixture => ({
  file: fixture.file,
  apply(source) {
    const actual = hash(source)
    if (actual === fixture.afterSha256) return source
    if (actual !== fixture.beforeSha256) throw new Error(`Studio model-selection fixture anchor drift: ${fixture.file}`)
    const edited = fixture.replacements.reduce((value, { before, after, count }) => {
      if (value.split(before).length - 1 !== count) throw new Error(`Studio model-selection fixture anchor count: ${fixture.file}`)
      return value.replaceAll(before, after)
    }, source)
    if (hash(edited) !== fixture.afterSha256) throw new Error(`Studio model-selection fixture anchor result: ${fixture.file}`)
    return edited
  },
}))
