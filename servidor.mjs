#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { abrirDados, agora, novoId } from './dados.mjs'

const dados = await abrirDados()

const servidor = new McpServer({ name: 'jobclip', version: '0.1.0' })

const texto = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] })
const erro = (m) => ({ content: [{ type: 'text', text: m }], isError: true })

const ANO = 365 * 86400000
const emMs = (aaaaMm) => {
  if (!aaaaMm) return null
  const [a, m] = String(aaaaMm).split('-')
  return Number(a) ? new Date(Number(a), Number(m || 1) - 1).getTime() : null
}

// ---------------------------------------------------------------- leitura

servidor.registerTool(
  'jobclip_resumo',
  {
    title: 'Resumo do JobClip',
    description:
      'Estado geral: quantas vagas em cada etapa do funil, o que está parado, e o que falta no material ' +
      '(perguntas sem resposta, temas sem prova, mudanças de emprego sem explicação). Comece por aqui.',
    inputSchema: {},
  },
  async () => {
    const [vagas, perguntas, respostas, experiencias, episodios, temas, perfil] = await Promise.all(
      ['vagas', 'perguntas', 'respostas', 'experiencias', 'episodios', 'temas', 'perfil'].map((c) => dados.listar(c)),
    )
    const porStatus = {}
    for (const v of vagas) porStatus[v.status] = (porStatus[v.status] ?? 0) + 1

    const paradas = vagas.filter(
      (v) => v.status === 'aplicada' && !v.proximoPassoEm && Date.now() - new Date(v.atualizadaEm).getTime() > 14 * 86400000,
    )
    const agenda = vagas
      .filter((v) => v.proximoPassoEm && !['encerrada', 'descartada'].includes(v.status))
      .sort((a, b) => a.proximoPassoEm.localeCompare(b.proximoPassoEm))
      .map((v) => ({ cargo: v.cargo, empresa: v.empresa, passo: v.proximoPasso, em: v.proximoPassoEm }))

    return texto({
      modo: dados.modo,
      perfil: perfil[0] ? { nome: perfil[0].nome, competencias: perfil[0].competencias?.length ?? 0 } : null,
      vagas: { total: vagas.length, porStatus, comTexto: vagas.filter((v) => (v.conteudo ?? '').length > 200).length },
      agenda,
      aplicadasParadas: paradas.map((v) => ({ cargo: v.cargo, empresa: v.empresa, desde: v.atualizadaEm.slice(0, 10) })),
      material: {
        perguntas: perguntas.length,
        semResposta: perguntas.filter((p) => !respostas.some((r) => r.perguntaId === p.id)).length,
        experiencias: experiencias.length,
        semPorQueSaiu: experiencias.filter((e) => !e.porQueSaiu?.trim()).length,
        episodios: episodios.length,
        episodiosSemTema: episodios.filter((e) => !e.temaIds?.length).length,
        temas: temas.length,
        temasSemProva: temas.filter((t) => !episodios.some((e) => e.temaIds?.includes(t.id))).length,
        temasSemTese: temas.filter((t) => !t.tese?.trim()).length,
      },
    })
  },
)

servidor.registerTool(
  'jobclip_vagas',
  {
    title: 'Vagas salvas',
    description:
      'Lista as vagas. Com incluir_texto, devolve a descrição inteira de cada uma — é esse texto que permite ' +
      'analisar requisitos de verdade, comparar exigências entre vagas e dizer o que falta estudar.',
    inputSchema: {
      status: z.enum(['a-aplicar', 'aplicada', 'em-processo', 'encerrada', 'descartada']).optional()
        .describe('filtra por etapa do funil'),
      busca: z.string().optional().describe('texto livre em cargo, empresa ou descrição'),
      incluir_texto: z.boolean().optional().describe('inclui a descrição completa; pesado, use quando for analisar'),
      limite: z.number().int().min(1).max(200).optional(),
    },
  },
  async ({ status, busca, incluir_texto, limite = 50 }) => {
    let vagas = await dados.listar('vagas')
    if (status) vagas = vagas.filter((v) => v.status === status)
    if (busca) {
      const t = busca.toLowerCase()
      vagas = vagas.filter((v) => `${v.cargo} ${v.empresa} ${v.conteudo ?? ''}`.toLowerCase().includes(t))
    }
    vagas.sort((a, b) => b.atualizadaEm.localeCompare(a.atualizadaEm))
    return texto(
      vagas.slice(0, limite).map((v) => ({
        id: v.id,
        cargo: v.cargo,
        empresa: v.empresa,
        status: v.status,
        local: v.local,
        salario: v.salario,
        proximoPasso: v.proximoPasso,
        proximoPassoEm: v.proximoPassoEm,
        url: v.url,
        notas: v.notas?.map((n) => `${n.em.slice(0, 10)}: ${n.texto}`),
        ...(incluir_texto ? { conteudo: v.conteudo } : { conteudoChars: (v.conteudo ?? '').length }),
      })),
    )
  },
)

servidor.registerTool(
  'jobclip_trajetoria',
  {
    title: 'Trajetória, episódios e temas',
    description:
      'A carreira inteira: empregos com por que entrou e por que saiu, episódios (o que aconteceu, incluindo o ' +
      'que deu errado) e temas — as afirmações sobre a pessoa, com os sinais de tese sem prova, prova antiga e ' +
      'concentração num emprego só.',
    inputSchema: {},
  },
  async () => {
    const [experiencias, episodios, temas] = await Promise.all(
      ['experiencias', 'episodios', 'temas'].map((c) => dados.listar(c)),
    )
    const nomeDe = (id) => {
      const e = experiencias.find((x) => x.id === id)
      return e ? `${e.cargo} · ${e.empresa}` : null
    }
    return texto({
      experiencias: experiencias
        .slice()
        .sort((a, b) => (b.inicio ?? '').localeCompare(a.inicio ?? ''))
        .map((e) => ({
          id: e.id, cargo: e.cargo, empresa: e.empresa,
          periodo: `${e.inicio} — ${e.fim || 'hoje'}`,
          oQueFazia: e.oQueFazia, porQueEntrou: e.porQueEntrou, porQueSaiu: e.porQueSaiu,
        })),
      episodios: episodios.map((e) => ({
        id: e.id, titulo: e.titulo, onde: nomeDe(e.experienciaId), quando: e.quando,
        desfecho: e.desfecho, numeros: e.numeros,
        contexto: e.contexto, acao: e.acao, resultado: e.resultado, temaIds: e.temaIds,
      })),
      temas: temas.map((t) => {
        const provas = episodios.filter((e) => e.temaIds?.includes(t.id))
        const datas = provas.map((e) => emMs(e.quando)).filter((x) => x != null)
        const ondes = new Set(provas.map((e) => e.experienciaId).filter(Boolean))
        return {
          id: t.id, nome: t.nome, tese: t.tese, frases: t.frases,
          provas: provas.map((e) => e.titulo),
          semTese: !t.tese?.trim(),
          semProva: provas.length === 0,
          provaVelha: datas.length > 0 && datas.every((d) => Date.now() - d > 2 * ANO),
          concentrado: provas.length >= 3 && ondes.size === 1,
        }
      }),
    })
  },
)

servidor.registerTool(
  'jobclip_perguntas',
  {
    title: 'Banco de perguntas e respostas',
    description:
      'As perguntas de entrevista e o que a pessoa escreveu para cada uma, por idioma. Use para revisar uma ' +
      'resposta, achar as que faltam, ou preparar uma vaga específica.',
    inputSchema: {
      momento: z.enum(['abertura', 'meio', 'fechamento']).optional(),
      origem: z.enum(['pack', 'minha', 'perguntaram']).optional(),
      idioma: z.enum(['pt', 'en', 'es']).optional().describe('idioma das respostas; padrão pt'),
      so_sem_resposta: z.boolean().optional(),
      busca: z.string().optional(),
    },
  },
  async ({ momento, origem, idioma = 'pt', so_sem_resposta, busca }) => {
    const [perguntas, respostas, temas] = await Promise.all(
      ['perguntas', 'respostas', 'temas'].map((c) => dados.listar(c)),
    )
    const nomeTema = (id) => temas.find((t) => t.id === id)?.nome ?? id
    let lista = perguntas
    if (momento) lista = lista.filter((p) => p.momento === momento)
    if (origem) lista = lista.filter((p) => p.origem === origem)
    if (busca) {
      const t = busca.toLowerCase()
      lista = lista.filter((p) => `${p.label} ${Object.values(p.texto ?? {}).join(' ')}`.toLowerCase().includes(t))
    }
    const saida = lista.map((p) => {
      const r = respostas.find((x) => x.perguntaId === p.id && x.idioma === idioma)
      return {
        id: p.id,
        label: p.label,
        pergunta: p.texto?.[idioma] ?? p.texto?.pt ?? p.texto?.en ?? p.label,
        momento: p.momento,
        origem: p.origem,
        temas: (p.temaIds ?? []).map(nomeTema),
        resposta: r ? { chave: r.chave, blocos: r.blocos, cues: r.cues, nota: r.nota, nivel: r.nivel } : null,
      }
    })
    return texto(so_sem_resposta ? saida.filter((x) => !x.resposta) : saida)
  },
)

servidor.registerTool(
  'jobclip_erros',
  {
    title: 'Falhas registradas',
    description:
      'Erros que o app gravou no banco da pessoa quando alguma tela quebrou. Sem serviço de ' +
      'monitoramento, é daqui que se descobre que algo falhou para quem está usando.',
    inputSchema: { limite: z.number().int().min(1).max(100).optional() },
  },
  async ({ limite = 20 }) => {
    const erros = await dados.listar('erros')
    if (!erros.length) return texto('Nenhuma falha registrada.')
    return texto(
      erros
        .slice()
        .sort((a, b) => (b.em ?? '').localeCompare(a.em ?? ''))
        .slice(0, limite)
        .map((e) => ({ em: e.em, rota: e.rota, mensagem: e.mensagem, componente: e.componente?.split('\n')[1]?.trim() })),
    )
  },
)

// ---------------------------------------------------------------- escrita

servidor.registerTool(
  'jobclip_vaga_atualizar',
  {
    title: 'Atualizar uma vaga',
    description:
      'Move a vaga no funil, define o próximo passo com data, ou acrescenta uma anotação. ' +
      'O histórico de status é mantido automaticamente.',
    inputSchema: {
      id: z.string().describe('id da vaga, vindo de jobclip_vagas'),
      status: z.enum(['a-aplicar', 'aplicada', 'em-processo', 'encerrada', 'descartada']).optional(),
      proximo_passo: z.string().optional().describe('ex: "Entrevista com a Ana"'),
      proximo_passo_em: z.string().optional().describe('AAAA-MM-DD'),
      nota: z.string().optional().describe('anotação nova; não apaga as anteriores'),
    },
  },
  async ({ id, status, proximo_passo, proximo_passo_em, nota }) => {
    const vagas = await dados.listar('vagas')
    const v = vagas.find((x) => x.id === id)
    if (!v) return erro(`Vaga ${id} não encontrada.`)

    const t = agora()
    const nova = { ...v, atualizadaEm: t }
    if (status && status !== v.status) {
      nova.status = status
      nova.historico = [...(v.historico ?? []), { status, em: t }]
    }
    if (proximo_passo !== undefined) nova.proximoPasso = proximo_passo || undefined
    if (proximo_passo_em !== undefined) nova.proximoPassoEm = proximo_passo_em || undefined
    if (nota) nova.notas = [{ texto: nota, em: t }, ...(v.notas ?? [])]

    await dados.gravar('vagas', nova)
    return texto(`Atualizada: ${nova.cargo} · ${nova.empresa} [${nova.status}]`)
  },
)

servidor.registerTool(
  'jobclip_resposta_salvar',
  {
    title: 'Escrever ou atualizar uma resposta',
    description:
      'Grava a resposta de uma pergunta num idioma. Escreva na voz da pessoa, usando os episódios reais dela — ' +
      'nunca invente fato, número ou empresa que não esteja na trajetória.',
    inputSchema: {
      pergunta_id: z.string(),
      idioma: z.enum(['pt', 'en', 'es']),
      chave: z.string().optional().describe('a frase que carrega a resposta; vira tema depois'),
      blocos: z.array(z.object({
        texto: z.string(),
        quando: z.string().optional().describe('condição, ex: "Se insistirem"'),
      })).describe('parágrafos do que dizer'),
      cues: z.array(z.string()).optional().describe('bullets para falar, não para ler'),
      nota: z.string().optional().describe('o que evitar'),
      nivel: z.enum(['forte', 'tem', 'lacuna']).optional(),
    },
  },
  async ({ pergunta_id, idioma, chave, blocos, cues, nota, nivel }) => {
    const perguntas = await dados.listar('perguntas')
    const p = perguntas.find((x) => x.id === pergunta_id)
    if (!p) return erro(`Pergunta ${pergunta_id} não encontrada.`)

    await dados.gravar('respostas', {
      id: `${pergunta_id}:${idioma}`,
      perguntaId: pergunta_id,
      idioma,
      chave: chave ?? '',
      blocos,
      cues: cues ?? [],
      nota,
      nivel,
      atualizadaEm: agora(),
    })
    return texto(`Resposta gravada para "${p.label}" em ${idioma}.`)
  },
)

servidor.registerTool(
  'jobclip_tema_salvar',
  {
    title: 'Criar ou editar um tema',
    description:
      'Tema é uma afirmação sobre a pessoa com prova anexada. A tese é interpretação dela — proponha, mas ' +
      'deixe claro que é proposta, e nunca substitua uma tese já escrita sem pedir.',
    inputSchema: {
      id: z.string().optional().describe('vazio cria um novo'),
      nome: z.string(),
      tese: z.string().optional().describe('o que isto afirma sobre a pessoa'),
      frases: z.record(z.string()).optional().describe('a formulação por idioma: { pt, en, es }'),
    },
  },
  async ({ id, nome, tese, frases }) => {
    const temas = await dados.listar('temas')
    const atual = id ? temas.find((t) => t.id === id) : null
    if (id && !atual) return erro(`Tema ${id} não encontrado.`)

    const t = {
      id: atual?.id ?? novoId(),
      nome,
      tese: tese ?? atual?.tese ?? '',
      frases: { ...(atual?.frases ?? {}), ...(frases ?? {}) },
      criadoEm: atual?.criadoEm ?? agora(),
    }
    await dados.gravar('temas', t)
    return texto(`${atual ? 'Atualizado' : 'Criado'}: ${t.nome}`)
  },
)

/** Atualizar tem que preservar o que nao foi mencionado: o Claude quase sempre
 *  fala de um campo so, e sobrescrever o resto com undefined apagaria trabalho
 *  da pessoa em silencio. */
function mesclar(atual, mudancas) {
  const out = { ...(atual ?? {}) }
  for (const [k, v] of Object.entries(mudancas)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

servidor.registerTool(
  'jobclip_episodio_salvar',
  {
    title: 'Registrar ou editar um episódio',
    description:
      'Algo que aconteceu na carreira da pessoa: contexto, o que ela fez, o que mudou. Use quando ela ' +
      'contar um caso e valer a pena guardar — inclusive quando deu errado, porque "me conta sobre um ' +
      'fracasso" é pergunta garantida.\n\n' +
      'Escreva com as palavras dela. Não invente número, empresa nem resultado: se algo faltar, ' +
      'pergunte em vez de preencher. Ligue a uma experiência sempre que souber qual foi, e a temas ' +
      'quando houver — sem tema o episódio não encontra pergunta nenhuma.',
    inputSchema: {
      id: z.string().optional().describe('vazio cria um novo; preencher edita e preserva o que não for citado'),
      titulo: z.string().optional().describe('uma linha, do jeito que ela contaria'),
      experiencia_id: z.string().optional().describe('de jobclip_trajetoria'),
      contexto: z.string().optional().describe('qual era a situação'),
      acao: z.string().optional().describe('o que ela fez'),
      resultado: z.string().optional().describe('o que mudou por causa disso'),
      numeros: z.string().optional().describe('o número que fica na cabeça de quem ouve, ex: "11 → 1"'),
      quando: z.string().optional().describe('AAAA-MM; é o que posiciona na linha do tempo'),
      desfecho: z.enum(['bom', 'ruim', 'misto']).optional(),
      tema_ids: z.array(z.string()).optional(),
    },
  },
  async (a) => {
    const episodios = await dados.listar('episodios')
    const atual = a.id ? episodios.find((e) => e.id === a.id) : null
    if (a.id && !atual) return erro(`Episódio ${a.id} não encontrado.`)
    if (!atual && !a.titulo?.trim()) return erro('Um episódio novo precisa de título.')

    const e = mesclar(atual, {
      id: atual?.id ?? novoId(),
      titulo: a.titulo,
      experienciaId: a.experiencia_id,
      contexto: a.contexto,
      acao: a.acao,
      resultado: a.resultado,
      numeros: a.numeros,
      quando: a.quando,
      desfecho: a.desfecho ?? atual?.desfecho ?? 'bom',
      temaIds: a.tema_ids ?? atual?.temaIds ?? [],
      criadaEm: atual?.criadaEm ?? agora(),
    })
    await dados.gravar('episodios', e)
    return texto(`${atual ? 'Atualizado' : 'Registrado'}: ${e.titulo}`)
  },
)

servidor.registerTool(
  'jobclip_experiencia_salvar',
  {
    title: 'Registrar ou editar uma experiência',
    description:
      'Um emprego na trajetória. Os dois campos que a entrevista mais cobra e que não existem em CV ' +
      'nenhum são porQueEntrou e porQueSaiu — vale insistir neles, com as palavras dela.\n\n' +
      'Para importar um currículo inteiro, prefira a tela de Trajetória do app: ela lê as datas e ' +
      'mostra tudo para conferir antes de gravar.',
    inputSchema: {
      id: z.string().optional().describe('vazio cria uma nova'),
      empresa: z.string().optional(),
      cargo: z.string().optional(),
      inicio: z.string().optional().describe('AAAA-MM'),
      fim: z.string().optional().describe('AAAA-MM; vazio significa emprego atual'),
      o_que_fazia: z.string().optional(),
      por_que_entrou: z.string().optional(),
      por_que_saiu: z.string().optional().describe('no emprego atual, por que quer sair'),
    },
  },
  async (a) => {
    const experiencias = await dados.listar('experiencias')
    const atual = a.id ? experiencias.find((e) => e.id === a.id) : null
    if (a.id && !atual) return erro(`Experiência ${a.id} não encontrada.`)
    if (!atual && !a.empresa?.trim() && !a.cargo?.trim()) {
      return erro('Uma experiência nova precisa de empresa ou cargo.')
    }

    const e = mesclar(atual, {
      id: atual?.id ?? novoId(),
      empresa: a.empresa,
      cargo: a.cargo,
      inicio: a.inicio,
      fim: a.fim,
      oQueFazia: a.o_que_fazia,
      porQueEntrou: a.por_que_entrou,
      porQueSaiu: a.por_que_saiu,
    })
    await dados.gravar('experiencias', e)
    return texto(`${atual ? 'Atualizada' : 'Registrada'}: ${e.cargo ?? ''} · ${e.empresa ?? ''}`)
  },
)

servidor.registerTool(
  'jobclip_pergunta_salvar',
  {
    title: 'Registrar ou editar uma pergunta',
    description:
      'Acrescenta uma pergunta ao banco. O caso mais valioso é registrar o que perguntaram DE VERDADE ' +
      'numa entrevista: use origem "perguntaram" e informe a vaga, porque é esse sinal que diz quais ' +
      'perguntas voltam.\n\n' +
      'Escreva o enunciado do jeito que foi feito, no idioma em que foi feito.',
    inputSchema: {
      id: z.string().optional().describe('vazio cria uma nova'),
      texto: z.string().optional().describe('o enunciado'),
      idioma: z.enum(['pt', 'en', 'es']).optional().describe('padrão pt'),
      label: z.string().optional().describe('nome curto para a lista; sem ele usa o começo do enunciado'),
      momento: z.enum(['abertura', 'meio', 'fechamento']).optional(),
      origem: z.enum(['minha', 'perguntaram']).optional(),
      vaga_id: z.string().optional().describe('quando origem = perguntaram'),
      tema_ids: z.array(z.string()).optional(),
    },
  },
  async (a) => {
    const perguntas = await dados.listar('perguntas')
    const atual = a.id ? perguntas.find((p) => p.id === a.id) : null
    if (a.id && !atual) return erro(`Pergunta ${a.id} não encontrada.`)
    if (!atual && !a.texto?.trim()) return erro('Uma pergunta nova precisa do enunciado.')

    const idioma = a.idioma ?? 'pt'
    const p = mesclar(atual, {
      id: atual?.id ?? novoId(),
      label: a.label ?? atual?.label ?? a.texto.slice(0, 42),
      texto: a.texto ? { ...(atual?.texto ?? {}), [idioma]: a.texto } : atual?.texto,
      momento: a.momento ?? atual?.momento ?? 'meio',
      origem: a.origem ?? atual?.origem ?? 'minha',
      vagaId: a.vaga_id,
      temaIds: a.tema_ids ?? atual?.temaIds ?? [],
      ordem: atual?.ordem ?? perguntas.length,
    })
    await dados.gravar('perguntas', p)
    return texto(`${atual ? 'Atualizada' : 'Registrada'}: ${p.label}`)
  },
)

servidor.registerTool(
  'jobclip_remover',
  {
    title: 'Apagar um registro',
    description:
      'Apaga de vez, sem lixeira. Confirme com a pessoa antes — cite o que vai sumir, pelo nome, e ' +
      'espere ela dizer que sim. Nunca apague em lote sem ela ter pedido em lote.',
    inputSchema: {
      colecao: z.enum(['vagas', 'perguntas', 'respostas', 'episodios', 'experiencias', 'temas', 'preparos', 'erros']),
      id: z.string(),
    },
  },
  async ({ colecao, id }) => {
    const itens = await dados.listar(colecao)
    const alvo = itens.find((x) => x.id === id)
    if (!alvo) return erro(`Nada com o id ${id} em ${colecao}.`)
    await dados.remover(colecao, id)
    const nome = alvo.titulo ?? alvo.label ?? alvo.nome ?? alvo.cargo ?? id
    return texto(`Apagado de ${colecao}: ${nome}`)
  },
)

await servidor.connect(new StdioServerTransport())
