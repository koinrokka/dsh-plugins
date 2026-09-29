/**
 * koinrokka llm-route:本包是「patch + 依赖载体」——
 * 真正的装载在 cordis.patch.yml(直接以 config 挂 @deepseek-ai/dsh-llm-pi-ai,
 * cordis 4 的 ctx.plugin 转手在 loader 语境下不生效,别走那条路)。
 * 此处只保留元信息;测试守 patch 与依赖钉版。
 */
export const name = 'llm-route'
