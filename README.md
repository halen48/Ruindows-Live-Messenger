# Ruindows Live Messenger

_Ruindows Live Messenger 2008: agora com mais zap e menos Microsoft._

São 15h47 de uma terça. Você chegou da escola, jogou a mochila no sofá, o
modem está fazendo barulho de fax morrendo e você precisa entrar no MSN antes
que a sua mãe precise usar o telefone. Aí você acorda: é 2026, você tem 30
anos, boletos, e todo mundo só fala pelo WhatsApp.

**Problema resolvido.** O Ruindows Live Messenger pega o seu WhatsApp de
verdade e enfia ele dentro de uma fantasia de **Windows Live Messenger 8.5**.
Janela separada pra cada conversa. "Fulano diz:". Chamar a atenção que treme a
janela. Aviso subindo do canto da tela. Emoticon de cerveja. E de brinde, o
ChatGPT e o Claude na sua lista de contatos, porque se a gente não consegue
mais ter amigos online às 3 da manhã, pelo menos tem IA.

Feito em Electron (sim, 300 MB de RAM pra um chat, é o preço da nostalgia).
O zap entra pelo [Baileys](https://github.com/WhiskeySockets/Baileys).
Nasceu de um fork do [eddmann/WhatsMSN](https://github.com/eddmann/WhatsMSN),
que era MSN 6 de XP, e foi promovido a 8.5 de Vista porque a gente tem padrão.

> **Os gráficos, sons e fontes do WLM 8.5 não vêm no repositório.** São da
> Microsoft e o Bill Gates tem advogado. Ficam em `src/renderer/assets/wlm85/`
> e `vendor/` (no `.gitignore`), pra quem tiver os seus.

## O que tem

### Entrar
- Tela de login do 8.5, só que no lugar do e-mail e senha tem o **QR do
  WhatsApp**. Escaneia uma vez e pronto, ele lembra de você (diferente da crush).
- A **sua foto** aparece na moldura enquanto conecta, com a cor do status
  que você saiu (entrou Ocupado, fica Ocupado).
- Barra de **sincronização** com porcentagem de verdade, pra você ter algo
  pra olhar enquanto o zap decide se gosta de você.

### Lista de contatos
- **Favoritos ★** (as conversas fixadas no zap), **Online**, **Grupos**,
  **Offline** e **Arquivadas** (fechadinha, pra você fingir que não existe).
- **Você** no topo do Online, pra mandar mensagem pra si mesmo igual um maluco.
- Tudo em ordem **alfabética**, porque a gente não é bicho.
- O subnick de cada um é o **recado** do zap, com emoticon do MSN. Finalmente
  um lugar pra aquele "Disponível" brilhar.
- Seu **nick**, **mensagem pessoal**, **foto** e **capa** editáveis. Pode
  botar `~*~xXx_GuI_xXx~*~` no nick, ninguém vai ver, é só visual.
- **Seu status**: Online, Ocupado (cala a boca de todo mundo: sem aviso, sem
  som), Ausente e Offline. Também só visual, o zap nem fica sabendo. E fica
  salvo, então você volta do jeito que saiu.

### Status dos contatos (a gambiarra mais honesta do app)
Ninguém deixa o "online" aparecer no zap, então a gente **inventa** o status
pela atividade da pessoa: última mensagem em qualquer lugar (com você ou em
qualquer grupo), reação, mensagem editada ou quando ela lê o que você mandou.
- até 1 h: **Online**; até 3 h: **Ausente**; depois disso: **Offline**.
- **Ocupado**: está falando no grupo mas largou você no vácuo há mais de
  15 min, ou o recado diz "trabalhando", "em reunião", "só urgências". A
  bolinha vermelha da vergonha.
- Se o zap entregar a presença real (online, digitando), vale ela.
- Dá pra mudar os minutos em ☰ > Opções de status dos contatos.

### Janela de conversa
- "Fulano diz: (14:32)", e mensagens seguidas da mesma pessoa **agrupadas**
  num cabeçalho só, pra quem manda 14 mensagens de uma palavra.
- **Respostas** (citações) do zap aparecem, com miniatura quando respondem
  foto ou vídeo, e dá pra responder (passa o mouse > Responder). Clicar na
  citação te leva até a mensagem original.
- **Reações** embaixo das mensagens (👍 2) e mensagens **editadas**.
- **Fotos**, **figurinhas** e **vídeos** (miniatura com ▶, toca na janela).
- **Está digitando...**; no grupo, "Fulano e Ciclano estão digitando no
  grupo..." pra você saber que vem textão.
- **Paleta de emoticons** do MSN (todos os 76) e aba de **Figurinhas** com as
  suas favoritas do zap, que envia num clique.
- **Alterar fonte** igual ao MSN: fonte do sistema, estilo, tamanho, cor.
  Comic Sans azul-bebê liberado. Negrito e itálico vão pro zap; o resto é só
  na sua tela (o zap não sabe o que é Comic Sans, coitado).
- **Chamar a atenção** (treme a janela), escrita à mão, enviar arquivo.

### Grupos
- Quem mandou aparece como **nick (número)**, ou **título no grupo (nick -
  número)** se a pessoa tiver título. Clica no nome e abre o privado.
- Foto do grupo e painel de **Participantes** na lateral, com Online,
  Ocupado, Ausente e Offline em ordem alfabética, ✎ em quem está digitando.
- Opção pra **grupos arquivados não abrirem janela** (vem desligada, porque
  a gente gosta de caos).

### Modo escuro
- Botão de **lua/sol** na barra da lista. Cinza escuro, não preto, porque a
  gente não é o Orkut gótico. Em ☰ > Tema... dá pra seguir o sistema.
- As cores do 8.5 são convertidas uma a uma, então foto, emoticon e emoji
  continuam com a cor certa. O tema fica salvo.

### Avisos, bandeja e sons
- Aviso subindo do canto com foto e "Fulano diz:", janela piscando na barra.
  Em Ocupado, nada disso: paz.
- Ícone na bandeja com os quatro status. Ícone do app é o do MSN, óbvio.
- Os sons originais. Sim, aquele.

### IAs na lista de contatos
- **ChatGPT**, **DeepSeek**, **Gemini** e **Claude** têm cada um a sua seção
  na lista, igual Grupos e Offline. Dois cliques em "Entrar no ..." e pronto.
- **Login**: clique em "Entrar no ..." > **Usar o login do Firefox**. O Google
  não deixa logar dentro de app nenhum ("Esse navegador ou app pode não ser
  seguro"), então o app pega a sessão que você já tem no Firefox (Google,
  ChatGPT, Claude, DeepSeek) e copia pra sessão das IAs. Feche o Firefox antes,
  pra ele gravar os logins recentes. Sem Firefox: "Entrar pelo site" e use
  e-mail/senha (não funciona pro Gemini).
- **Grupos de IAs**: várias IAs na mesma janela, estilo ChatALL. Cada uma
  conversa no seu próprio chat do site, e a cada mensagem recebe só o que
  ainda não viu (o que você e as outras disseram). Dá pra escolher se
  respondem **todas juntas** ou **em sequência** (cada uma lê e pode rebater a
  anterior), e ☰ > **Mais uma rodada entre elas** deixa o barraco continuar
  sem você. Dois cliques num participante abre o chat dele sozinho.
- **Sessões do Claude Code** deste PC aparecem na seção do Claude, com o
  título que o Claude Code deu. Abre com o histórico (só os textos, sem as
  ferramentas) e dá pra mandar mensagem: roda `claude -p --resume` na pasta da
  sessão. Sessão mexida nos últimos 2 minutos fica só leitura, pra não brigar
  com o terminal onde ela está aberta.
- Os sites ficam abertos escondidos só enquanto trabalham; parados, são
  descarregados (senão comem CPU e até o mouse fica lento).
- Não usa alguma? Botão direito > Esconder. Pra voltar: botão de adicionar
  contato > Mostrar na lista.
- Você entra com **a sua conta** no site de cada uma (abre uma janela na
  primeira vez, depois lembra). Cada IA vira uma seção com **Nova conversa**
  e o seu **histórico** de chats do site.
- A conversa abre numa janela do MSN e a IA "está digitando" enquanto pensa.
  É o mais perto que você vai chegar de ter alguém online às 3 da manhã.
- Funciona controlando o site por baixo dos panos, então quebra quando o site
  muda de layout. O login do Google (Gemini) às vezes acha que o app é robô.
  Ele tem razão.

### Mídia e espaço em disco
☰ > **Opções de mídia...**
- **Guardar no disco**: fotos e vídeos ficam no PC e são apagados se ninguém
  abrir em X horas/dias, com limite de MB.
- **Temporário**: baixa enquanto o app está aberto e apaga tudo ao fechar.
  Pra HD lotado de 2009.
- **Baixar fotos automaticamente** desligado: só baixa quando você clica. Pra
  quem está no 4G do plano controle.
- Apagou? Clica de novo que baixa de novo.

## Rodar

```sh
npm install      # também aplica o scripts/patch-baileys.js
npm start
```

Escaneia o QR no celular: **Configurações > Aparelhos conectados > Conectar
um aparelho**.

### Instaladores

```sh
npm run dist:linux   # AppImage e .deb
npm run dist:win     # instalador e versão portátil
npm run dist:mac     # .dmg (precisa rodar num Mac)
```

Sai tudo em `dist/`. Usa o electron-builder, que o `npx` baixa na hora.

### Modo demo (sem zap)

```sh
MSN_DEMO=1 npm start
```

Contatos de mentira de 2004, numa pasta separada, sem tocar na sua sessão.
Ótimo pra tirar print sem expor a família.

### Variáveis de ambiente

| Variável | Pra quê |
| --- | --- |
| `MSN_DEMO=1` | Dados de mentira, sem WhatsApp |
| `MSN_DEBUG=1` | Log completo do Baileys (prepare o terminal) |
| `MSN_SHOT_DIR` | Salva um PNG de cada janela depois de carregar |
| `MSN_SHOT_DELAY` | Quanto esperar antes do PNG, em ms (padrão 1500) |
| `MSN_SHOT_CHAT` | No demo, abre essa conversa (ex.: `crew@g.us`) |
| `MSN_SHOT_PROBE` | JS executado em cada janela antes do PNG |
| `HTTPS_PROXY` | Proxy pro WebSocket do WhatsApp |

## Onde o app guarda as coisas

| O quê | Linux | Windows | macOS |
| --- | --- | --- | --- |
| Sessão, mensagens, configurações | `~/.config/whatsmsn` | `%APPDATA%\whatsmsn` | `~/Library/Application Support/whatsmsn` |
| Mídia (modo guardar) | `~/.cache/whatsmsn/media` | `%LOCALAPPDATA%\whatsmsn\Cache\media` | `~/Library/Caches/whatsmsn/media` |
| Mídia (modo temporário) e cache do navegador | `/dev/shm/whatsmsn-<uid>` (RAM) | pasta temp | pasta temp |

Dentro da pasta de dados:

| Caminho | O que é |
| --- | --- |
| `wa-data/baileys-auth/` | Sessão do zap. Apagou, lê o QR de novo |
| `wa-data/store.json` | Conversas, contatos, mensagens (200 por conversa), status, títulos, figurinhas favoritas |
| `wa-data/sync.log` | Quando a sincronização dá ruim |
| `wlm-settings.json` | Nick, mensagem, fotos, capa, fonte, status, tema, opções, IAs |
| `Partitions/ai` | Login das IAs (uma sessão só pra todas) |

**Não coloque a pasta de dados no temp.** O zap só manda o histórico completo
uma vez, quando você lê o QR. Perdeu, perdeu.

## Consertos no Baileys

O `scripts/patch-baileys.js` roda sozinho depois de todo `npm install` e:
- ignora quando o zap manda apagar uma coisa que nunca existiu (sem isso,
  fixados e arquivados nunca sincronizavam: a biblioteca surtava e jogava o
  pacote inteiro fora);
- repassa as **figurinhas favoritas**, que o Baileys jogava no lixo;
- guarda o envelope de cada mensagem, pra investigar onde o zap esconde o
  título dos membros do grupo.

## Avisos sérios (no meio da zoeira)

- Protocolo não oficial do WhatsApp. A Meta não aprova e automação pesada pode
  banir o número. Use com a sua conta, com calma, sem disparar spam.
- O controle dos sites das IAs usa a sua conta pessoal de um jeito que os
  termos de uso delas não preveem.
- Windows Live Messenger é da Microsoft. Isto aqui é uma homenagem de fã, sem
  fins lucrativos, pra uso pessoal. Por favor, Microsoft, não.
