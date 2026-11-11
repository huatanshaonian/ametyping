// The portable OpenCode configuration the guide starts from (the models in use on huatanshaonian, 2026-11-11).
// Regenerate from that computer's opencode.json; the same content is served as /downloads/opencode-magpie.json.
export const BASE_CONFIG = {
  "$schema": "https://opencode.ai/config.json",
  "model": "magpie/group/opus-main",
  "agents": {
    "general": {
      "model": "magpie/group/deepseek-worker"
    },
    "explore": {
      "model": "magpie/group/deepseek-worker"
    }
  },
  "providers": {
    "magpie": {
      "name": "Magpie",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://magapi.huatan.org/v1",
        "apiKey": "{file:~/.config/opencode/.secrets/magpie-nas.key}"
      },
      "models": {
        "group/opus-main": {
          "name": "Opus · 日常",
          "modelID": "group/opus-main",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 64000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          }
        },
        "devin/claude-opus-5-5": {
          "name": "Opus 5.5 · Devin",
          "modelID": "devin/claude-opus-5-5",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 128000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ],
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            }
          }
        },
        "devin/claude-fable-5-2": {
          "name": "Fable 5.2 · Devin",
          "modelID": "devin/claude-fable-5-2",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 128000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ],
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max"
              ]
            }
          }
        },
        "devin/gpt-6-astra": {
          "name": "GPT-6 Astra · Devin",
          "modelID": "devin/gpt-6-astra",
          "package": "@opencode/ai/providers/openai-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 128000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ],
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
                "ultra"
              ]
            }
          }
        },
        "devin/swe-2": {
          "name": "SWE-2 · Devin",
          "modelID": "devin/swe-2",
          "package": "@opencode/ai/providers/openai-compatible",
          "limit": {
            "context": 262000,
            "input": 262000,
            "output": 128000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ],
            "reasoning": {
              "supported": true,
              "effort": [
                "medium",
                "high",
                "max"
              ]
            }
          }
        },
        "devin/gemini-4-carbon": {
          "name": "Gemini 4 Carbon · Devin",
          "modelID": "devin/gemini-4-carbon",
          "package": "@opencode/ai/providers/openai-compatible",
          "limit": {
            "context": 1048576,
            "input": 1048576,
            "output": 1000000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ],
            "reasoning": {
              "supported": true,
              "effort": [
                "low",
                "medium",
                "high"
              ]
            }
          }
        },
        "group/gemini-argon": {
          "name": "Gemini Argon",
          "modelID": "group/gemini-argon",
          "package": "@opencode/ai/providers/openai-compatible",
          "limit": {
            "context": 1048576,
            "input": 1048576,
            "output": 65536
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          }
        },
        "group/deepseek-worker": {
          "name": "DeepSeek Flash · 子 Agent",
          "modelID": "group/deepseek-worker",
          "package": "@opencode/ai/providers/openai-compatible",
          "limit": {
            "context": 1048576,
            "input": 1048576,
            "output": 393216
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          }
        },
        "kiro/claude-opus-5.5": {
          "name": "Opus 5.5 · Kiro",
          "modelID": "kiro/claude-opus-5.5",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 64000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ]
          }
        },
        "auto/claude-opus-5-5": {
          "name": "NAS - auto/claude-opus-5-5",
          "modelID": "auto/claude-opus-5-5",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 128000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          },
          "disabled": true
        },
        "auto/claude-sonnet-5-5": {
          "name": "NAS - auto/claude-sonnet-5-5",
          "modelID": "auto/claude-sonnet-5-5",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 128000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          },
          "disabled": true
        },
        "deepseek/deepseek-flash": {
          "name": "NAS - deepseek/deepseek-flash",
          "modelID": "deepseek/deepseek-flash",
          "limit": {
            "context": 1048576,
            "input": 1048576,
            "output": 393216
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ]
          },
          "disabled": true
        },
        "deepseek/deepseek-v4-pro": {
          "name": "NAS - deepseek/deepseek-v4-pro",
          "modelID": "deepseek/deepseek-v4-pro",
          "limit": {
            "context": 1048576,
            "input": 1048576,
            "output": 393216
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text"
            ],
            "output": [
              "text"
            ]
          },
          "disabled": true
        },
        "paratera/DeepSeek-V4.1-Flash": {
          "name": "NAS - paratera/DeepSeek-V4.1-Flash",
          "modelID": "paratera/DeepSeek-V4.1-Flash",
          "limit": {
            "context": 1048576,
            "input": 1048576,
            "output": 384000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          },
          "disabled": true
        },
        "paratera/DeepSeek-V4-Pro-0813": {
          "name": "NAS - paratera/DeepSeek-V4-Pro-0813",
          "modelID": "paratera/DeepSeek-V4-Pro-0813",
          "limit": {
            "context": 1048576,
            "input": 1048576,
            "output": 384000
          },
          "capabilities": {
            "tools": true
          },
          "disabled": true
        },
        "paratera/DeepSeek-V4-Flash-Vision-Exp": {
          "name": "NAS - paratera/DeepSeek-V4-Flash-Vision-Exp",
          "modelID": "paratera/DeepSeek-V4-Flash-Vision-Exp",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 384000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          },
          "disabled": true
        },
        "kiro/claude-sonnet-5.5": {
          "name": "NAS - kiro/claude-sonnet-5.5",
          "modelID": "kiro/claude-sonnet-5.5",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 64000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ]
          },
          "disabled": true
        },
        "kiro/claude-opus-4.8": {
          "name": "NAS - kiro/claude-opus-4.8",
          "modelID": "kiro/claude-opus-4.8",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 64000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ]
          },
          "disabled": true
        },
        "kiro/claude-haiku-5.5": {
          "name": "NAS - kiro/claude-haiku-5.5",
          "modelID": "kiro/claude-haiku-5.5",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 64000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ]
          },
          "disabled": true
        },
        "kiro/claude-opus-4.6": {
          "name": "NAS - kiro/claude-opus-4.6",
          "modelID": "kiro/claude-opus-4.6",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 64000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ],
            "output": [
              "text"
            ]
          },
          "disabled": true
        },
        "antigravity/gemini-4-argon": {
          "name": "NAS - antigravity/gemini-4-argon",
          "modelID": "antigravity/gemini-4-argon",
          "limit": {
            "context": 1048576,
            "input": 1048576,
            "output": 65536
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          },
          "disabled": true
        },
        "antigravity/claude-opus-5-5": {
          "name": "NAS - antigravity/claude-opus-5-5",
          "modelID": "antigravity/claude-opus-5-5",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 128000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          },
          "disabled": true
        },
        "antigravity/claude-sonnet-5-5": {
          "name": "NAS - antigravity/claude-sonnet-5-5",
          "modelID": "antigravity/claude-sonnet-5-5",
          "package": "@opencode/ai/providers/anthropic-compatible",
          "limit": {
            "context": 1000000,
            "input": 1000000,
            "output": 128000
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          },
          "disabled": true
        },
        "antigravity/gemini-3.8-flash": {
          "name": "NAS - antigravity/gemini-3.8-flash",
          "modelID": "antigravity/gemini-3.8-flash",
          "limit": {
            "context": 1048576,
            "input": 1048576,
            "output": 65536
          },
          "capabilities": {
            "tools": true,
            "input": [
              "text",
              "image"
            ]
          },
          "disabled": true
        }
      }
    }
  }
};
