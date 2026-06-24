# NovelExtractor 启动指南

## 📋 前置准备

### 1. 确认已安装（✅ 已完成）
```bash
# 包已安装，可以直接使用
novel-extractor --help
```

### 2. 配置 DeepSeek API Key

**方式一：创建 .env 文件（推荐）**
```bash
# 复制示例文件
cp .env.example .env

# 编辑 .env 文件，填入你的 API Key
notepad .env
```

`.env` 文件内容：
```ini
DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
```

**方式二：设置环境变量**
```powershell
# Windows PowerShell
$env:DEEPSEEK_API_KEY = "sk-xxxxxxxxxxxxxxxx"
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"
$env:DEEPSEEK_MODEL = "deepseek-v4-flash"
```

---

## 🚀 快速启动

### Step 1: 查看执行计划（不调用模型）
```bash
novel-extractor plan --config config/novel_extractor.mvp.yaml
```

**输出示例**：
```
Novel: 凡人修仙传
Window size: 5
Stride: 4
Max windows: 60
Templates: 5个模板
Chapter batches: total 120, will process 60
First chapter batches: 1-5, 5-9, 9-13, 13-17, 17-21
```

### Step 2: 执行提取（开始调用模型）

**基础模式**：
```bash
novel-extractor run --config config/novel_extractor.mvp.yaml
```

**详细模式（推荐）**：
```bash
# 开启 verbose 模式，查看详细的 token 统计
# 修改配置文件 config/novel_extractor.mvp.yaml:
# console:
#   verbose: true

novel-extractor run --config config/novel_extractor.mvp.yaml
```

**导出 Metrics（用于分析省 token 效果）**：
```bash
novel-extractor run --config config/novel_extractor.mvp.yaml --metrics metrics.json
```

---

## 📊 省 Token 功能验证

### 1. 观察控制台输出

**正常输出应该包含**：
```
[窗口 1/60] 1-5
  路由命中：resource_group
  [resource_group] running
    模板输出：丹药分析.md, 材料分析.md
    本次命中 80% | 平均命中 80% | 会话 tokens 5,234 | 本次 tokens 5,234 | 本次费用 ¥0.0123
    写入：丹药分析.md
    写入：材料分析.md
    状态：completed
```

**重点关注**：
- ✅ **本次命中率**：首次应该是 0%（冷启动），第2次开始应该达到 70-90%
- ✅ **平均命中率**：随着窗口增加，应该稳定在 75-85%
- ✅ **费用**：有缓存后，每个窗口费用应该显著降低

### 2. 查看 metrics.json

```bash
cat metrics.json
```

**关键指标**：
```json
{
  "request_count": 159,
  "prompt_tokens": 30921429,
  "completion_tokens": 159,
  "total_tokens": 33359906,
  "cache_hit_tokens": 30292148,    // 缓存命中
  "cache_miss_tokens": 462509,     // 缓存未命中
  "cost": 1.22,                    // 总费用（元）
  "currency": "¥"
}
```

**省 Token 效果计算**：
- 缓存命中率 = `cache_hit_tokens / (cache_hit_tokens + cache_miss_tokens)`
- 如果没有缓存，费用 ≈ `1.22 / 0.80 * (1 + 0.02/1.0) ≈ 1.55元`
- **实际节省** ≈ `(1.55 - 1.22) / 1.55 = 21%` 的费用

---

## 🛠️ 常用命令

### 查看任务状态
```bash
novel-extractor status --config config/novel_extractor.mvp.yaml
```

### 中断后恢复
```bash
# Ctrl+C 中断后，使用 resume 继续
novel-extractor resume --config config/novel_extractor.mvp.yaml
```

### 重置指定窗口（如果某个窗口失败需要重跑）
```bash
novel-extractor reset-window --config config/novel_extractor.mvp.yaml \
  --window 5-9 --group resource_group
```

---

## ⚙️ 配置调优

### 1. Economy Profile（已启用）
```yaml
token_saving:
  tool_surface:
    profile: "economy"  # 只暴露5个必需工具，减少 schema tokens
```

### 2. 提高详细度
```yaml
console:
  verbose: true        # 显示详细的 cache 诊断信息
  show_skipped: true   # 显示跳过的模板组
```

### 3. 调整窗口大小（如果 token 超预算）
```yaml
window:
  size: 3              # 从 5 章减少到 3 章
  stride: 2            # 相应减少步长
```

### 4. 限制 token 预算
```yaml
token_saving:
  metrics:
    run_token_budget: 1000000  # 限制单次运行最多使用 100 万 tokens
```

---

## 🔍 故障排查

### 问题 1: `DEEPSEEK_API_KEY not found`
**解决**：
```bash
# 方式 1: 检查 .env 文件是否存在
cat .env

# 方式 2: 直接设置环境变量
$env:DEEPSEEK_API_KEY = "your-key"
```

### 问题 2: 模型返回 401 Unauthorized
**解决**：
- 检查 API Key 是否正确
- 检查是否有余额
- 访问 https://platform.deepseek.com/api_keys 验证

### 问题 3: 缓存命中率始终是 0%
**可能原因**：
```yaml
# 检查配置是否禁用了缓存
token_saving:
  prompt_cache:
    enabled: true              # 必须是 true
    diagnose_prefix_changes: true
```

### 问题 4: 右侧 UI 面板显示 0
**说明**：
- 这是已知问题（UI 数据绑定），不影响后端功能
- 控制台日志是准确的
- 使用 `--metrics` 导出 JSON 可以看到完整统计

---

## 📈 预期效果

### 第一个窗口（冷启动）
```
本次命中 0% | 平均命中 0% | 会话 tokens 5,234 | 本次费用 ¥0.0052
```

### 第二个窗口（缓存生效）
```
本次命中 82% | 平均命中 41% | 会话 tokens 10,468 | 本次费用 ¥0.0062
                                                       ^^^^^^^^^^^
                                              增量费用仅 0.001 元！
```

### 第 10 个窗口（稳定状态）
```
本次命中 85% | 平均命中 80% | 会话 tokens 52,340 | 累计费用 ¥0.0320
```

**对比无缓存**：同样 10 个窗口，费用约 ¥0.050，**节省 36%**

---

## 🎯 下一步

1. **先小规模测试**：设置 `max_windows: 5` 测试功能
2. **验证输出质量**：检查生成的 Markdown 文档
3. **观察省 token 效果**：对比 metrics.json 中的缓存命中率
4. **调整配置**：根据实际情况优化窗口大小和模板
5. **全量运行**：设置 `max_windows: null` 处理全书

---

## 📞 获取帮助

```bash
# 查看所有命令
novel-extractor --help

# 查看特定命令帮助
novel-extractor run --help

# 运行测试（验证功能正常）
pytest tests/ -v
```

**现在可以开始了！运行第一条命令试试：**
```bash
novel-extractor plan --config config/novel_extractor.mvp.yaml
```
