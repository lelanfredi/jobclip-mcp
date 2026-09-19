import { readFile, writeFile } from 'node:fs/promises'

/**
 * Tres backends com a mesma assinatura. O primeiro e o que qualquer pessoa usa.
 *
 *   Pessoa     JOBCLIP_TOKEN
 *              o proprio token da pessoa, copiado do app em Ajustes. Fala com o
 *              Firestore pela REST sujeito as MESMAS regras do navegador dela:
 *              se as regras nao deixam ela ler o dado de outra pessoa, este
 *              servidor tambem nao consegue. E o modo recomendado.
 *
 *   Arquivo    JOBCLIP_BACKUP
 *              aponta para um JSON exportado pelo app. Nao precisa de Firebase
 *              nem de credencial nenhuma. Bom pra usar offline ou experimentar.
 *
 *   Administrador  JOBCLIP_SERVICE_ACCOUNT + JOBCLIP_UID
 *              chave de conta de servico, que IGNORA as regras e enxerga o banco
 *              inteiro. Nao distribua. Existe so pra manutencao de quem cuida do
 *              projeto.
 */

const COLECOES = ['vagas', 'perguntas', 'respostas', 'preparos', 'perfil', 'experiencias', 'episodios', 'temas', 'erros']

function backendArquivo(caminho) {
  let cache = null
  const ler = async () => {
    if (cache) return cache
    const bruto = JSON.parse(await readFile(caminho, 'utf8'))
    if (bruto?.app !== 'jobclip') throw new Error(`${caminho} não é um backup do JobClip.`)
    cache = bruto
    for (const c of COLECOES) if (!Array.isArray(cache[c])) cache[c] = []
    return cache
  }
  return {
    modo: `arquivo (${caminho})`,
    async listar(colecao) {
      return (await ler())[colecao] ?? []
    },
    async gravar(colecao, item) {
      const b = await ler()
      const lista = (b[colecao] ??= [])
      const i = lista.findIndex((x) => x.id === item.id)
      if (i >= 0) lista[i] = item
      else lista.push(item)
      await writeFile(caminho, JSON.stringify(b, null, 2))
    },
    async remover(colecao, id) {
      const b = await ler()
      b[colecao] = (b[colecao] ?? []).filter((x) => x.id !== id)
      await writeFile(caminho, JSON.stringify(b, null, 2))
    },
  }
}

async function backendFirestore(chave, uid) {
  // firebase-admin e opcional: so este modo precisa dele, e ele pesa ~40 MB.
  let initializeApp, cert, getFirestore
  try {
    ;({ initializeApp, cert } = await import('firebase-admin/app'))
    ;({ getFirestore } = await import('firebase-admin/firestore'))
  } catch {
    throw new Error(
      'O modo de manutencao precisa do firebase-admin, que nao vem instalado por padrao.\n' +
        'Rode `npm install firebase-admin` na pasta do servidor.\n\n' +
        'Se voce so quer usar o JobClip normalmente, use JOBCLIP_TOKEN em vez disso: ' +
        'o comando esta no app, em Ajustes -> Conectar o Claude.',
    )
  }
  const credencial = JSON.parse(await readFile(chave, 'utf8'))
  const app = initializeApp({ credential: cert(credencial) })
  const db = getFirestore(app)
  const col = (nome) => db.collection('users').doc(uid).collection(nome)
  return {
    modo: `Firestore (projeto ${credencial.project_id}, usuário ${uid})`,
    async listar(colecao) {
      const snap = await col(colecao).get()
      return snap.docs.map((d) => ({ ...d.data(), id: d.id }))
    },
    async gravar(colecao, item) {
      await col(colecao).doc(item.id).set(item)
    },
    async remover(colecao, id) {
      await col(colecao).doc(id).delete()
    },
  }
}

export async function abrirDados() {
  const token = process.env.JOBCLIP_TOKEN
  const arquivo = process.env.JOBCLIP_BACKUP
  const chave = process.env.JOBCLIP_SERVICE_ACCOUNT
  const uid = process.env.JOBCLIP_UID

  if (token) {
    const { backendPessoa } = await import('./firestore.mjs')
    return backendPessoa(token)
  }
  if (arquivo) return backendArquivo(arquivo)
  if (chave && uid) return backendFirestore(chave, uid)

  throw new Error(
    'Falta dizer de onde ler os dados.\n\n' +
      'O jeito normal: abra o JobClip, vá em Ajustes → Conectar o Claude, e copie o comando de lá.\n' +
      'Ele define JOBCLIP_TOKEN, que é o seu token de acesso.\n\n' +
      'Alternativa sem conexão: JOBCLIP_BACKUP=/caminho/jobclip-AAAA-MM-DD.json',
  )
}

export const novoId = () => globalThis.crypto.randomUUID()
export const agora = () => new Date().toISOString()
