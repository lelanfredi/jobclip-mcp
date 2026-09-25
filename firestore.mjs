/**
 * Firestore pela API REST, autenticando COMO A PESSOA.
 *
 * Por que não usar o SDK de administrador: a chave de conta de serviço é do
 * projeto inteiro e ignora as regras do Firestore de propósito. Entregar essa
 * chave a alguém é entregar o banco todo, inclusive os dados dos outros.
 *
 * Aqui é o contrário. A pessoa entra no app, copia o próprio token, e este
 * servidor troca esse token por credencial de acesso e fala com o Firestore
 * pela REST — sujeito às mesmas regras que o navegador dela. Se as regras não
 * deixam ela ler o dado de outra pessoa, este servidor também não consegue.
 */

const ENDERECO_TOKEN = 'https://securetoken.googleapis.com/v1/token'
const ENDERECO_DB = 'https://firestore.googleapis.com/v1'

// Qual projeto Firebase. Vem de fora, sempre -- não há valor padrão aqui, e
// isso é deliberado.
//
// POR QUE NÃO TEM PADRÃO
// Havia: a chave e o id do projeto do JobClip vinham embutidos. A chave web do
// Firebase de fato não é segredo (ela vai em todo cliente web; quem protege os
// dados são as regras do Firestore), e o comentário que estava aqui dizia isso
// e estava certo.
//
// O problema era outro, e maior: com um padrão, quem instalasse este servidor e
// configurasse só o próprio token acabaria falando com o projeto de OUTRA
// pessoa -- a dona do padrão. Um servidor que serve a qualquer um não pode vir
// apontado para o Firebase de alguém.
//
// De quebra resolve o alerta do GitHub, que não sabe distinguir chave pública
// de credencial — e um alerta que não dá para distinguir de vazamento real tem
// custo próprio.
function config(opcoes) {
  const apiKey = opcoes.apiKey ?? process.env.JOBCLIP_API_KEY
  const projeto = opcoes.projeto ?? process.env.JOBCLIP_PROJECT
  if (!apiKey || !projeto) {
    throw new Error(
      'Faltou dizer qual projeto Firebase usar.\n\n' +
        'Abra o JobClip em Ajustes → Conectar o Claude: o comando de lá já vem\n' +
        'com JOBCLIP_API_KEY e JOBCLIP_PROJECT preenchidos.\n\n' +
        'Sem conexão, use JOBCLIP_BACKUP com um arquivo exportado.',
    )
  }
  return { apiKey, projeto }
}

// ---------------------------------------------------------------- conversão

/** O Firestore REST tipa cada valor. Nossa estrutura é JSON comum, então a
 *  conversão acontece nas duas pontas. */
function paraValor(v) {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(paraValor) } }
  return { mapValue: { fields: paraCampos(v) } }
}

function paraCampos(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue // undefined não existe no Firestore
    out[k] = paraValor(v)
  }
  return out
}

function deValor(v) {
  if (!v || typeof v !== 'object') return null
  if ('stringValue' in v) return v.stringValue
  if ('booleanValue' in v) return v.booleanValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('timestampValue' in v) return v.timestampValue
  if ('nullValue' in v) return null
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(deValor)
  if ('mapValue' in v) return deCampos(v.mapValue.fields ?? {})
  return null
}

const deCampos = (campos) =>
  Object.fromEntries(Object.entries(campos ?? {}).map(([k, v]) => [k, deValor(v)]))

// ---------------------------------------------------------------- backend

export async function backendPessoa(tokenDeAtualizacao, opcoes = {}) {
  const { apiKey, projeto } = config(opcoes)

  let acesso = null
  let expiraEm = 0
  let uid = null

  /** O token de acesso dura uma hora; este servidor pode ficar aberto o dia
   *  todo, então renova sozinho pouco antes de vencer. */
  async function credencial() {
    if (acesso && Date.now() < expiraEm - 60_000) return acesso

    const r = await fetch(`${ENDERECO_TOKEN}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenDeAtualizacao }),
    })
    const corpo = await r.json()
    if (!r.ok) {
      const motivo = corpo?.error?.message ?? r.status
      throw new Error(
        motivo === 'TOKEN_EXPIRED' || motivo === 'INVALID_REFRESH_TOKEN' || motivo === 'USER_NOT_FOUND'
          ? 'Token inválido ou expirado. Abra o JobClip em Ajustes → Conectar o Claude e copie um novo.'
          : `Não consegui autenticar no Firebase: ${motivo}`,
      )
    }
    acesso = corpo.id_token
    uid = corpo.user_id
    expiraEm = Date.now() + Number(corpo.expires_in ?? 3600) * 1000
    return acesso
  }

  async function chamar(caminho, init = {}) {
    const token = await credencial()
    const r = await fetch(`${ENDERECO_DB}/projects/${projeto}/databases/(default)/documents/${caminho}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
    if (r.status === 404) return null // coleção ou documento que ainda não existe
    if (!r.ok) {
      const corpo = await r.text()
      if (r.status === 403) {
        throw new Error(
          'O Firestore recusou o acesso. Se o JobClip está em teste fechado, o seu e-mail precisa ' +
          'estar na lista de permitidos das regras.',
        )
      }
      throw new Error(`Firestore respondeu ${r.status}: ${corpo.slice(0, 200)}`)
    }
    return r.status === 204 ? null : r.json()
  }

  await credencial() // falha cedo, com mensagem clara, em vez de na primeira ferramenta

  return {
    modo: `Firestore como você (projeto ${projeto}, usuário ${uid})`,

    async listar(colecao) {
      const itens = []
      let pagina
      do {
        const q = new URLSearchParams({ pageSize: '300' })
        if (pagina) q.set('pageToken', pagina)
        const r = await chamar(`users/${uid}/${colecao}?${q}`)
        if (!r) break
        for (const d of r.documents ?? []) {
          itens.push({ ...deCampos(d.fields), id: d.name.split('/').pop() })
        }
        pagina = r.nextPageToken
      } while (pagina)
      return itens
    },

    async gravar(colecao, item) {
      await chamar(`users/${uid}/${colecao}/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: paraCampos(item) }),
      })
    },

    async remover(colecao, id) {
      await chamar(`users/${uid}/${colecao}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },
  }
}
