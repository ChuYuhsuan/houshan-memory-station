# 贡献指南

感谢关注厚山忆站。提交 Issue 或 Pull Request 前，请先确认：

1. 不包含真实 API Key、账号、密码或任何用户数据。
2. 不包含未授权的教材全文、患者数据或学校内部资料。
3. 描述清楚问题、复现步骤与期望行为。

## 开发

```bash
npm install
npm start
```

打包：

```bash
npm run dist
```

## 提交 PR

- 保持改动聚焦，一个 PR 解决一个问题。
- 涉及界面的改动请附截图（注意遮挡个人信息）。
- 涉及 AI 提示词的改动请说明对出题质量、引用依据与 token 成本的影响。
- 不要提交 `dist/`、`node_modules/`、`*.exe`、`release-assets/` 或本机配置。

## 代码风格

- 原生 JavaScript，保持现有单文件结构。
- 新增 UI 请复用现有设计变量与组件类，避免再引入一套视觉语言。
- 中文文案简洁、准确，不夸大 AI 能力。

## 安全

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中粘贴密钥或数据。
