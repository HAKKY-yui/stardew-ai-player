# Stardew AI Player — 让 AI 用键鼠当第二个玩家

> 一个 AI agent 通过**真实的键盘鼠标输入**在《星露谷物语》里当玩家：自己看地图、自己走过去、自己浇水收割、自己花钱买东西。
>
> **不用 mod 操纵角色**——mod 只提供"读世界"和"按键落点"的最小桥，所有动作都是人一样的按键。

**Unofficial project.** Stardew Valley, SMAPI and all related names/assets belong to their respective owners. Not affiliated with ConcernedApe.

> ## ⚠️ 实验性项目（experimental）
>
> **所有功能都处于试验阶段**：输入注入、感知、寻路、农活、联机主持、挂机——没有稳定版，也没有一条流程被完整验证过。
>
> 尤其是**输入层只做过粗略测试**：同一台机器、同一个游戏版本、少量样本。换 Windows 版本、输入法、键盘布局、窗口前后台状态，都可能表现不同，我们没有系统核实过。
>
> **别拿它管你的主力存档。** 先备份，再在隔离存档里试。

---

## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| AI 控制**一个真实角色**（本地联机里当 host 或 farmhand），用键盘/鼠标驱动 | 不是"再生成一个 NPC 陪你"（那种方案见 [DEPENDENCIES](docs/DEPENDENCIES.md) 的"其他做法"一节） |
| 感知来自一个**本地 HTTP 桥**读游戏状态（只读） | 不修改存档、不刷钱、不加速时间 |
| 路网靠**自己走过去**建立并自我修正 | 不调用游戏内部寻路、不读游戏内存 |
| 可无人值守跑完一整天（浇水 → 采集 → 回城 → 睡觉） | 不保证不迷路：卡住了会如实报 `unreachable` |

两层验收：**L1 手**（按键能驱动角色）、**L2 眼**（能自己建图、跨图不撞墙），再往上才是 **L3 一起玩**、**L4 挂机**。

---

## 架构

```
        ┌────────────────────────────┐
        │  agent (你的模型/脚本)      │
        └──────────┬─────────────────┘
                   │ HTTP 读状态（只读）
                   ▼
        ┌────────────────────────────┐        ┌──────────────────┐
        │  bridge mod (本地 7850)     │◀──────▶│  Stardew Valley   │
        └────────────────────────────┘        │  + SMAPI          │
                   ▲                          └────────┬─────────┘
                   │ 按键落点                          │
        ┌──────────┴─────────────────┐                 │
        │  input layer (PowerShell)   │─────────────────┘
        │  PostMessage / SetCursorPos │   KEYDOWN+WM_CHAR+KEYUP
        └────────────────────────────┘
                   ▲
        ┌──────────┴─────────────────┐
        │  pathmap engine (Node)      │  每格 {state, kind, cost, ttl} 持久化
        └────────────────────────────┘
```

- **input layer**（实验性）：`scripts/keyer.ps1`（常驻按键进程，支持 `down`/`up` 长按）、`inject.ps1`（一次性投键）、`win.ps1`（截图/移动真实鼠标/聚焦窗口）、`gethwnd.ps1`（找窗口句柄）、`host.ps1`（摆窗口 + 点开联机主持）。
- **感知**：`/state`、`/surroundings`、`/menu`（见 [DEPENDENCIES](docs/DEPENDENCIES.md)）。
- **pathmap engine**：`scripts/pathmap.mjs`——A\* + 逐格可信度 + 撞到就重测，路网存在存档旁边的 JSON 里。

### 脚本速查

| 脚本 | 干什么 | 怎么用 |
|---|---|---|
| `pathmap.mjs` | 建图 / 规划 / 走过去（主入口） | `node scripts/pathmap.mjs go --to 42,58`<br>`node scripts/pathmap.mjs go --to 42,57 --via Farm,BusStop,Town`<br>子命令：`scan` `plan --to x,y` `clear --at x,y` `info` |
| `nav.mjs` | 按已有路网走，边走边纠错 | `node scripts/nav.mjs --to 42,58 [--hold 200] [--max 40] [--hwnd 0x..]` |
| `walk.mjs` | 纯记录：朝一个方向走 N 格并写下撞到什么 | `node scripts/walk.mjs --dir right --steps 10 [--map Farm]` |
| `keyer.ps1` | 常驻按键进程（长按走位靠它） | stdin 协议：`<hwnd-hex> <key> <holdMs\|down\|up>` |
| `inject.ps1` | 一次性投键（不常驻） | `-Hwnd 0x2f048 -Key x -Method post -HoldMs 120 [-Count 2]` |
| `win.ps1` | 截图 / 用真光标点击 / 聚焦窗口 | `win.ps1 shot out.png [窗口标题] [--full]`<br>`win.ps1 click 640 435` |
| `gethwnd.ps1` | 打印 `[main player]` 实例的窗口句柄（十六进制） | 无参数；找不到时 `exit 1` |
| `host.ps1` | 摆好窗口 → 点「合作」→「主持」→ 选存档行 | 无参数；窗口位置在文件顶部 `$winX/$winY/$winW/$winH` |
| `launch-secondary.ps1` | 起第二个（0 mod）实例 | `-GameDir "<游戏目录>" [-ModsPath Mods-secondary]`，或设 `STARDEW_GAME` |
| `altf4.ps1` | 对指定窗口发 Alt+F4（退出用） | `-Hwnd 0x2f048` |
| `list-windows.ps1` | 列标题匹配的窗口 + 句柄（排查用） | `[-Match Stardew]` |

---

## 依赖（重要，先读这个）

**本仓库不包含、也不再分发任何第三方 Mod 的二进制**。你需要自己准备：

1. **Stardew Valley 1.6.15** + **SMAPI**（自行安装）
2. 一个**本地 HTTP 桥 Mod**（提供 `/state` `/surroundings` `/menu`，默认端口 7850）
   → 我们用的是 `JunimoBridge`（作者 mlkgrnt，**未声明开源许可，因此不能随仓库分发**）。
   详见 [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md)。**没有这个桥，本项目跑不起来。**
3. **Node.js 18+**、**PowerShell**（7 优先，没装自动用系统自带的 5.1）

> 如果你拿不到那个桥：本仓库的 `input layer` + `pathmap engine` 仍然可读可学，但要接自己的实现。
> 桥的接口契约见 [PLAYBOOK §1](docs/PLAYBOOK.md#1-桥的接口契约)。

---

## 快速开始

```bash
git clone https://github.com/<your-account>/stardew-ai-player.git
cd stardew-ai-player

# 脚本认这几个环境变量（PowerShell 用 $env:NAME = "..."）
export SDV_BRIDGE=http://localhost:7850
export STARDEW_SAVES="$APPDATA/StardewValley/Saves"

# 可选：默认用 PowerShell 7（pwsh），没装就自动回退 5.1（powershell）
# export SDV_POWERSHELL=pwsh        # 或 powershell，强制指定

# 可选：跳过自动找窗口，直接指定句柄
# export STARDEW_HWND=0x000000000002f048
```

`config.example.json` 是**参数清单**（参考值 + 说明），不是脚本自动读取的配置文件；
其中 `window`、`input`、`play` 这几项目前对应 `scripts/host.ps1` 顶部常量与各脚本里的默认值，
要改就改脚本，或者你自己接一个读 config 的入口。

1. **确认桥在线**
   ```bash
   curl -s http://localhost:7850/state
   ```
2. **拿到窗口句柄**（认标题里的 `[main player]`，不认 mod 数量）
   ```powershell
   powershell -File scripts/gethwnd.ps1
   ```
3. **走一格**（`go` 会自己建图、绕障、必要时清障）
   ```bash
   node scripts/pathmap.mjs go --to 42,58
   ```
4. **跨图**
   ```bash
   node scripts/pathmap.mjs go --to 42,57 --via Farm,BusStop,Town
   ```
5. **收工**：[PLAYBOOK §9](docs/PLAYBOOK.md#9-收工用返程时间倒推) 有"几点必须往回走"的算式。

---

## 已知限制（别指望它什么都能干）

- **输入层未完全核实**：本文档对按键方式的结论只来自粗略测试（见 [PLAYBOOK §2](docs/PLAYBOOK.md#2-输入层为什么只有一种按键方式有效)），不保证在你的机器上成立。
- **联机里冻不住时间**：客户端暂停只冻自己那份，两边时钟会错开 → 本项目**不做**时间暂停/加速。
- **看不见另一个玩家**：桥返回的 `farmers` 是空的，所以做不了"跟着人类走"。
- **Co-op 里的睡觉/占床**、**建筑搬迁**、**买动物**在部分桥版本上不可靠——这些是环境问题，不是本项目的 bug。
- **SMAPI 版本敏感**：验证于 `1.6.15 + SMAPI 4.5.2`；其他版本未验证。
- **窗口位置写死**在 `scripts/host.ps1` 顶部（`$winX/$winY/$winW/$winH`），按你的显示器改。

---

## 安全与伦理

- **先备份存档**：AI 会花你的金币、砍你的作物、走错路。
- 只在**单人 / 自建联机**里用，别拿去别人的服务器。
- 不提供**改存档刷钱**、**时间加速**、**透视**等功能——这不是能力不足，是设计边界。

---

## 参考与致谢

见 [NOTICE](NOTICE)。特别说明：`docs/PLAYBOOK.md` 里"日内节奏 / 采购出门判据 / 回执语义"三节的结构参考了
[CSXizhang/star](https://github.com/CSXizhang/star)（Apache-2.0），已按本项目的实现重写，不是直接复制。

## License

[Apache-2.0](LICENSE)。
