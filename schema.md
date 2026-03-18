# 🧱 Tabela usuarios

id — UUID

nome — obrigatório

nickname — único, verificar duplicata

email — único, verificar duplicata

senha — hash bcrypt

imageProfile — base64 ou URL, com imagem padrão ao criar conta

imageCover — base64 ou URL, com imagem padrão ao criar conta

bio — texto, com mensagem padrão ao criar conta

status — online, offline, away, busy (padrão: offline)

last_seen — data/hora da última atividade do usuário

deleted_at — data/hora de exclusão lógica (soft delete, padrão: null)

created_at — data de criação

updated_at — data de atualização via trigger

# 🧱 Tabela perfis

id — UUID

nome — administrador, moderador, usuario

# 🔗 Tabela usuario_perfil

usuario_id

perfil_id

📌 Regras

Ao criar conta, o perfil padrão é usuario

Apenas usuários com perfil administrador podem alterar perfis

# 🤝 Tabela amizades

# id — UUID

usuario_id — usuário que enviou a solicitação

amigo_id — usuário que recebeu

status — pendente, aceito, recusado, bloqueado

created_at — data de criação

updated_at — data da ação

🧠 Regras de Negócio
🟢 Status do usuário

online → usuário ativo no sistema

away → usuário sem interação por um período (ex: 5 min)

busy → definido manualmente (não deseja ser incomodado)

offline → desconectado

⏱️ Last Seen

Atualizado quando houver atividade do usuário

Usado para exibir:

"visto por último em X"

Não precisa ser atualizado em tempo real (usar intervalo otimizado)

🗑️ Soft Delete (deleted_at)

Usuário não é removido do banco

Apenas marcado como deletado

📌 Comportamento

Usuário com deleted_at:

❌ não pode autenticar

❌ não aparece em buscas/listagens

✔️ permanece para histórico (ex: mensagens)

🤝 Sistema de Amizades
📩 Envio de solicitação

cria registro com status pendente

✅ Aceite

status muda para aceito

recomendado: criar relação bidirecional (2 registros)

❌ Recusa

status muda para recusado

🚫 Bloqueio

status muda para bloqueado

📌 Validações de amizade

❌ usuário não pode adicionar a si mesmo

❌ não pode duplicar solicitação

❌ não pode enviar convite se já for amigo

❌ não pode interagir com usuário bloqueado

🔄 Regras gerais

nickname e email devem ser únicos

senha sempre armazenada com hash seguro (bcrypt)

# 🧱 Tabela conversas

Representa um chat (privado ou grupo)

id — UUID

tipo — privado, grupo

nome — nome do grupo (null para privado)

created_by — usuário que criou

created_at — data de criação

updated_at — última atividade (nova mensagem)

# 🔗 Tabela conversa_participantes

Quem faz parte da conversa

id — UUID

conversa_id

usuario_id

role — admin, membro

joined_at — quando entrou

left_at — quando saiu (null = ativo)

# 🧱 Tabela mensagens

id — UUID

conversa_id

usuario_id — quem enviou

conteudo — texto da mensagem

tipo — texto, imagem, video, arquivo

created_at — data de envio

updated_at — edição (opcional)

deleted_at — soft delete da mensagem

# 👁️ Tabela mensagens_lidas

Controle de leitura

id — UUID

mensagem_id

usuario_id

lido_em — data de leitura

🧠 Regras de Negócio (Chat)
💬 Conversa privada (1:1)

criada automaticamente ao iniciar chat entre 2 usuários

só pode existir 1 conversa privada por par de usuários

só pode existir se forem amigos (status = aceito)

👥 Conversa em grupo

criada por um usuário

pode ter múltiplos participantes

participantes podem:

entrar

sair

ser removidos (admin)

✉️ Envio de mensagens

usuário precisa estar na conversa

não pode enviar se:

saiu da conversa

está bloqueado (no caso de privado)

👁️ Leitura de mensagens

ao visualizar conversa:

registra em mensagens_lidas

usado para:

✔️ "visualizado"

✔️ contador de não lidas

🗑️ Soft delete de mensagem

deleted_at:

mensagem não aparece mais

mas permanece no banco

💡 opcional:

“Mensagem apagada” no frontend

🔗 Integração com amizades
📌 Regras

chat privado só existe se:

amizade = aceito

se usuário for bloqueado:

❌ não pode enviar mensagem

❌ pode ocultar conversa

🔄 Atualização de conversa

sempre que enviar mensagem:

atualizar conversas.updated_at

💡 usado para:

ordenar chats (tipo WhatsApp)

📊 Estados importantes
Mensagem

enviada

entregue (opcional)

lida

Usuário

online / offline

last_seen

🚀 Fluxo resumido
📩 Criar conversa privada

verificar amizade (aceito)

verificar se já existe conversa

se não existir → criar

adicionar 2 participantes

✉️ Enviar mensagem

validar participante

criar mensagem

atualizar conversa (updated_at)

opcional: notificar via websocket

👁️ Ler mensagens

usuário abre chat

marcar mensagens como lidas

⚡ Melhorias futuras (nível pro)

✔️ WebSocket (tempo real)

✔️ typing (digitando...)

✔️ anexos com upload externo (S3, etc)

✔️ reações 👍❤️

✔️ responder mensagem (reply)

✔️ editar mensagem

✔️ apagar para todos

