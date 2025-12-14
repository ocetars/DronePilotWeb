# 无人机 MCP Server

标准 MCP (Model Context Protocol) Server 实现，允许 AI Agent（如 Claude Desktop）通过 MCP 协议控制浏览器内的无人机模拟器。

## 架构

```
┌─────────────────┐     stdio      ┌─────────────────┐   WebSocket   ┌─────────────────┐
│  Claude Desktop │ ◄────────────► │   MCP Server    │ ◄───────────► │  浏览器模拟器    │
│  或 MCP Inspector│               │  (Node.js)      │               │  (ThreeScene)   │
└─────────────────┘                └─────────────────┘               └─────────────────┘
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动（按此顺序！）

**终端 1** - 启动前端：
```bash
npm run dev
```

**终端 2** - 启动 MCP Inspector：
```bash
npm run mcp:inspector
```
Inspector 会显示一个 URL（如 http://localhost:5173 或 http://127.0.0.1:xxxx），在浏览器中打开。

**终端 3 / 浏览器** - 打开模拟器：
在浏览器中打开 http://localhost:5173（前端页面）

### 3. 验证连接

在浏览器控制台（F12）中应该看到：
```
[DroneWsBridge] ✅ Connected to MCP Server at ws://localhost:8765
```

如果看到 `⏳ MCP Server not available`，说明 MCP Server 还没启动或端口被占用。

### 4. 在 Inspector 中测试

1. 在 MCP Inspector 界面点击 "Connect"
2. 在 Tools 列表中选择 `drone.take_off`
3. 点击执行，观察浏览器中无人机起飞

### 4. 集成到 Claude Desktop

在 Claude Desktop 配置文件中添加：

**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "drone-pilot": {
      "command": "node",
      "args": ["C:/Users/你的用户名/Desktop/DronePilotWeb/mcp/server.js"]
    }
  }
}
```

配置后重启 Claude Desktop，就可以在对话中使用无人机控制工具了。

## 可用工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `drone.get_state` | 获取无人机当前状态 | 无 |
| `drone.hover` | 立即悬停，取消当前任务 | 无 |
| `drone.take_off` | 起飞到指定高度 | `altitude`: 高度(米)，默认1.0 |
| `drone.land` | 降落到地面 | 无 |
| `drone.move_to` | 移动到指定位置 | `x`, `z`: 必填; `y`: 高度，可选 |
| `drone.run_mission` | 执行航线任务 | `waypoints`: 航点数组 |
| `drone.cancel` | 取消所有任务 | 无 |
| `drone.pause` | 暂停当前任务 | 无 |
| `drone.resume` | 继续暂停的任务 | 无 |

## 航点类型 (Waypoint Types)

在 `run_mission` 中使用的航点类型：

- `takeOff`: 起飞，参数 `altitude`
- `land`: 降落
- `moveTo`: 移动到位置，参数 `x`, `y`, `z`
- `hover`: 悬停，参数 `durationMs` (悬停时间毫秒)

## 示例对话

在 Claude Desktop 中：

> 用户：帮我控制无人机起飞到1.5米高度，然后飞到坐标(1, 1)的位置

Claude 会调用：
1. `drone.take_off` with `{"altitude": 1.5}`
2. `drone.move_to` with `{"x": 1, "z": 1}`

## 调试

开发模式下，以下对象会挂载到浏览器 window：

- `window.__drone`: 无人机实例
- `window.__droneWsBridge`: WebSocket 桥接实例

可在浏览器控制台中直接调用：

```javascript
// 获取状态
window.__drone.getState()

// 手动起飞
await window.__drone.api.takeOff(1.5)

// 移动
await window.__drone.api.moveTo({x: 1, z: 1})
```

## 故障排查

1. **MCP Inspector 无法连接**
   - 确保浏览器已打开模拟器页面
   - 检查浏览器控制台是否有 WebSocket 错误
   - 确认端口 8765 没有被占用

2. **工具调用超时**
   - 检查浏览器是否正常加载了无人机模型
   - 查看 MCP Server 的 stderr 输出

3. **无人机不动**
   - 确认浏览器控制台有 `[DroneWsBridge] WebSocket connected` 日志
   - 检查是否有 JavaScript 错误
