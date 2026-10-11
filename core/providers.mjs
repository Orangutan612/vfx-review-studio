/**
 * providers.mjs —— 模型服务商预设。
 *
 * 用途：让完全不懂 API 的人也能配好 —— 在网页上选一家、粘一个 Key、点「测试并保存」。
 * 所有条目都走 OpenAI 兼容的 /chat/completions，所以换了家只是换 base_url + 模型名。
 */

/**
 * 「测试连接」用的图：64×64 纯红 PNG。
 * 刻意不只是发一句「你好」—— 那样只能验证 Key 有效，验证不了**模型能不能读图**，
 * 而读图恰恰是这个工具唯一的硬需求。
 */
export const TEST_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwIqof2UTMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj12qxUDxeFqrFAAAAABJRU5ErkJggg==';

export const TEST_QUESTION = '这张图的主体是什么颜色？只回答一个中文颜色词。';

/**
 * needsKey: false 的（如本地 Ollama）不需要 Key。
 * keyUrl 是给小白直接点过去申请的地方。
 */
export const PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek（推荐 · 国内直连）',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    needsKey: true,
    note: 'deepseek-flash 支持读图，价格便宜、国内直连不需要梯子。注册后在「API Keys」页面新建一个，复制过来即可。',
  },
  {
    id: 'dashscope',
    label: '通义千问 Qwen-VL（阿里云百炼）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max-latest',
    keyUrl: 'https://bailian.console.aliyun.com/',
    needsKey: true,
    note: '阿里云百炼的 OpenAI 兼容入口。开通后模型名如果变了，直接改「模型名」这一栏。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM-4V（bigmodel）',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-plus',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    needsKey: true,
    note: 'GLM-4V 系列支持读图。模型名如有更新，直接改下面那一栏。',
  },
  {
    id: 'moonshot',
    label: 'Kimi 视觉（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    needsKey: true,
    note: 'Kimi 的多模态模型支持图片输入。模型名如有更新，直接改下面那一栏。',
  },
  {
    id: 'ark',
    label: '豆包 · 火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-1-6-vision-250815',
    keyUrl: 'https://console.volcengine.com/ark',
    needsKey: true,
    note: '火山方舟通常要先用「推理接入点」的 ID 当模型名（形如 ep-xxxx），请把接入点 ID 填到「模型名」。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    keyUrl: 'https://platform.openai.com/api-keys',
    needsKey: true,
    note: '国内访问需要网络条件。',
  },
  {
    id: 'ollama',
    label: '本地 Ollama（完全免费 · 不联网）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5vl:7b',
    keyUrl: 'https://ollama.com/download',
    needsKey: false,
    note: '先装 Ollama，再执行 ollama pull qwen2.5vl:7b。图片不出本机，但小模型给的建议质量会明显低一些。',
  },
  {
    id: 'custom',
    label: '自定义 / 中转站',
    baseUrl: '',
    model: '',
    keyUrl: '',
    needsKey: true,
    note: '填你自己的 OpenAI 兼容地址（到 /v1 为止，不要带 /chat/completions）。',
  },
];

export function findProvider(id) {
  return PROVIDERS.find(item => item.id === id) || null;
}

/** 给网页用的精简列表（不把测试图发过去）。 */
export function publicProviders() {
  return PROVIDERS.map(({ id, label, baseUrl, model, keyUrl, needsKey, note }) => ({
    id, label, baseUrl, model, keyUrl, needsKey, note,
  }));
}
