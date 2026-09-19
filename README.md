# JobClip — servidor MCP

Deixa o Claude (ou o Codex, ou qualquer cliente MCP) ler e mexer no seu
[JobClip](https://jobclip-f52f9.web.app): revisar o funil de candidaturas,
escrever resposta de entrevista na sua voz a partir dos seus próprios episódios,
formular a tese de um tema, mover uma vaga.

```bash
claude mcp add jobclip -e JOBCLIP_TOKEN=... -- npx -y github:lelanfredi/jobclip-mcp
```

O token sai do próprio app, em **Ajustes → Conectar o Claude**.

## O que ele expõe

**Lê**

| Ferramenta | O que faz |
|---|---|
| `jobclip_resumo` | estado geral: funil, agenda, o que está parado, o que falta no material |
| `jobclip_vagas` | lista e filtra vagas; com `incluir_texto`, devolve a descrição inteira |
| `jobclip_trajetoria` | empregos com o porquê de cada mudança, episódios e temas com os sinais |
| `jobclip_perguntas` | banco de perguntas com as respostas por idioma |
| `jobclip_erros` | falhas que o app gravou quando alguma tela quebrou |

**Escreve**

| Ferramenta | O que faz |
|---|---|
| `jobclip_vaga_atualizar` | move no funil, define próximo passo, anota |
| `jobclip_resposta_salvar` | escreve ou atualiza a resposta de uma pergunta |
| `jobclip_episodio_salvar` | registra o que aconteceu, inclusive o que deu errado |
| `jobclip_experiencia_salvar` | um emprego, com por que entrou e por que saiu |
| `jobclip_pergunta_salvar` | acrescenta pergunta; `origem: perguntaram` marca o que caiu de verdade |
| `jobclip_tema_salvar` | cria ou edita um tema |
| `jobclip_remover` | apaga de vez, sem lixeira |

Atualizar **preserva o que não foi citado**: falar de um campo só não apaga os
outros.

**Não existe uma ferramenta de "analisar competências", e isso é de propósito.**
A versão do app faz busca literal por lista de termos, porque lá não roda modelo
nenhum. Aqui quem lê é o Claude: `jobclip_vagas` com `incluir_texto` entrega a
descrição inteira, e a análise sai com compreensão de verdade em vez de
correspondência de palavra.

## O que dá para pedir

```
Compara as vagas que salvei e me diz o que se repete nos requisitos.
Entrevista na Acme amanhã: lê a vaga e me diz quais perguntas provavelmente caem.
Escreve minha resposta de "me conta sobre um fracasso" usando meus episódios reais.
Teve uma vez que perdi um cliente por prometer data sem falar com engenharia — registra isso.
Acabaram de me perguntar X na entrevista. Guarda no banco.
Quais dos meus temas não têm prova nenhuma?
Põe meus "por que saí" lado a lado. Tem um padrão?
Move a vaga da Acme pra em processo e marca entrevista dia 25.
```

## Configurar

### O jeito normal: o seu próprio token

1. Abra o JobClip e vá em **Ajustes → Conectar o Claude**
2. Clique em **Mostrar o comando** e copie
3. Cole no terminal

O comando fica assim, com o seu token no lugar do `...`:

```bash
claude mcp add jobclip -e JOBCLIP_TOKEN=... -- npx -y github:lelanfredi/jobclip-mcp
```

Não precisa clonar nada: o `npx` busca e roda direto deste repositório.

**O que esse token é:** uma credencial da sua conta do JobClip. O servidor troca
ele por acesso ao Firestore e fala com o banco **sujeito às mesmas regras que o
seu navegador**. Se as regras não deixam você ler o dado de outra pessoa, o
servidor também não consegue. Trate como senha: não publique e não mande por
chat. Se vazar, saia da conta em todos os dispositivos e pegue um comando novo.

### Sem conexão: um arquivo exportado

No app: **Ajustes → Seus dados → Exportar tudo (JSON)**. Depois:

```bash
claude mcp add jobclip -e JOBCLIP_BACKUP=$HOME/Downloads/jobclip-2026-09-19.json \
  -- npx -y github:lelanfredi/jobclip-mcp
```

Lê e escreve nesse arquivo, sem credencial nenhuma. Para levar as mudanças de
volta, importe o arquivo em Ajustes → Seus dados. Bom para usar offline ou para
experimentar antes de conectar a conta.

### Manutenção: conta de serviço

```bash
npm install firebase-admin   # só este modo precisa dele
JOBCLIP_SERVICE_ACCOUNT=~/.jobclip/chave.json JOBCLIP_UID=<uid> node servidor.mjs
```

> **Não distribua este modo.** A chave de conta de serviço é do projeto inteiro e
> **ignora as regras do Firestore** — enxerga o banco todo, inclusive os dados de
> outras pessoas. Existe só para quem cuida do projeto. Para qualquer outra
> pessoa, o modo do token acima faz a mesma coisa com o escopo certo.

## Conferir se subiu

```bash
JOBCLIP_TOKEN=... npx -y github:lelanfredi/jobclip-mcp
```

Sem erro e sem sair, está certo — ele fica esperando o cliente falar por stdio.
Ctrl+C para encerrar. Token errado ou vencido aparece na hora, dizendo o que
fazer.

## Quando pedir para escrever

O servidor escreve, então vale combinar no pedido:

- **na sua voz**, a partir dos episódios reais — o prompt das ferramentas já diz
  para não inventar fato, número nem empresa fora da trajetória
- **tese de tema é sua**: a ferramenta pede para propor, não substituir
- revise antes de usar numa entrevista; o que está escrito aqui vai sair da sua
  boca
