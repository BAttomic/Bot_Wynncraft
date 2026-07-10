import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ChannelType,
} from 'discord.js';
import { ObjectId } from 'mongodb';
import { collections } from '../../db/mongo.js';
import { getConfig } from '../../config/guildConfig.js';
import { audit } from '../../services/audit.js';

/**
 * Ciclo de vida de um empréstimo:
 *   open ──(venceu)──> overdue ──┐
 *     │                          ├──> repaid | cancelled
 *     └──────────────────────────┘
 *
 * `open` e `overdue` são ambos ATIVOS. Tratar só `open` como ativo era um bug:
 * assim que o job de lembretes marcava o vencimento, o empréstimo sumia do
 * /loan list e não podia mais ser quitado.
 * @type {readonly string[]}
 */
export const ACTIVE_STATUSES = Object.freeze(['open', 'overdue']);

/** Prazo padrão de todo empréstimo. Devolver antes é sempre permitido. */
export const DEFAULT_LOAN_DAYS = 7;

/**
 * Ranks DA GUILDA que podem abrir um empréstimo. "Chief ou superior" = chief e
 * owner, já que `guildRank` guarda o rank real do jogo.
 * @type {readonly string[]}
 */
const MANAGER_GUILD_RANKS = Object.freeze(['chief', 'owner']);

const STATUS_LABEL = {
  open: 'em aberto',
  overdue: '⚠️ atrasado',
  repaid: 'pago',
  cancelled: 'cancelado',
};

const DAY_MS = 86_400_000;

/** @param {object} loan @returns {string} */
function describe(loan) {
  return loan.type === 'emeralds' ? `${loan.amount} esmeraldas` : loan.itemDesc;
}

/** @param {object} loan @returns {string} */
function fmtLoan(loan) {
  const due = `<t:${Math.floor(new Date(loan.dueAt).getTime() / 1000)}:R>`;
  const thread = loan.threadId ? ` · <#${loan.threadId}>` : '';
  return `\`${loan._id}\` — <@${loan.borrowerDiscordId}>: **${describe(loan)}** · vence ${due} · *${STATUS_LABEL[loan.status] ?? loan.status}*${thread}`;
}

/** @param {string} raw @returns {ObjectId|null} */
function toObjectId(raw) {
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
}

/**
 * Staff do Discord, ou Chief/Owner da guilda no jogo.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
async function isLoanManager(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const linked = await collections.members().findOne({ discordId: interaction.user.id });
  return MANAGER_GUILD_RANKS.includes(linked?.guildRank);
}

/** Texto do acordo, postado dentro do tópico. */
function agreementEmbed(borrowerId, dueAt) {
  return {
    title: '📄 Acordo de Empréstimo',
    color: 0xf1c40f,
    description:
`Devedor: <@${borrowerId}>
Devolução até <t:${Math.floor(dueAt.getTime() / 1000)}:F> (<t:${Math.floor(dueAt.getTime() / 1000)}:R>)

**Itens incluídos**
A staff lista abaixo os itens (ou o código do trade). Todos devem estar protegidos com \`/itemlock\`.

**Valor estimado**
A combinar.

**Confirmação**
Anexe as prints do trade. O devedor precisa **responder neste tópico** confirmando que recebeu.

-# Devoluções antecipadas são livres. Para estender o prazo, formalize um novo acordo.`,
  };
}

/** Passo 1 do botão: escolher o devedor. */
async function promptBorrower(interaction) {
  if (!(await isLoanManager(interaction))) {
    return interaction.reply({
      content: 'Apenas **Chief ou superior** pode abrir um empréstimo.',
      ephemeral: true,
    });
  }
  const menu = new UserSelectMenuBuilder()
    .setCustomId('loan:borrower')
    .setPlaceholder('Quem vai receber o empréstimo?')
    .setMaxValues(1);

  return interaction.reply({
    content: `Escolha o devedor. O prazo padrão é de **${DEFAULT_LOAN_DAYS} dias**.`,
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  });
}

/** Passo 2: cria o tópico, adiciona o membro e registra o empréstimo. */
async function openLoanThread(interaction) {
  if (!(await isLoanManager(interaction))) {
    return interaction.update({ content: 'Sem permissão.', components: [] });
  }
  await interaction.deferUpdate();

  const borrowerId = interaction.values[0];
  const cfg = await getConfig(interaction.guildId);
  const channel = await interaction.client.channels
    .fetch(cfg.channels?.loans ?? interaction.channelId)
    .catch(() => null);
  if (!channel) {
    return interaction.editReply({ content: 'Canal de empréstimos inacessível.', components: [] });
  }

  const borrower = await interaction.guild.members.fetch(borrowerId).catch(() => null);
  const name = borrower?.displayName ?? borrowerId;
  const dueAt = new Date(Date.now() + DEFAULT_LOAN_DAYS * DAY_MS);

  const thread = await channel.threads.create({
    name: `Empréstimo — ${name}`.slice(0, 100),
    autoArchiveDuration: 10080, // 7 dias, igual ao prazo
    type: ChannelType.PublicThread,
    reason: `Empréstimo aberto por ${interaction.user.tag}`,
  });
  await thread.members.add(borrowerId).catch(() => {});

  const linked = await collections.members().findOne({ discordId: borrowerId });
  const { insertedId } = await collections.loans().insertOne({
    borrowerDiscordId: borrowerId,
    borrowerUuid: linked?.uuid ?? null,
    type: 'item',
    amount: null,
    itemDesc: 'A definir no tópico',
    createdAt: new Date(),
    dueAt,
    status: 'open',
    createdBy: interaction.user.id,
    threadId: thread.id,
    dueSoonNotified: false,
    overdueReminders: 0,
    lastReminderAt: null,
  });

  await thread.send({
    content: `<@${borrowerId}>`,
    embeds: [agreementEmbed(borrowerId, dueAt)],
    allowedMentions: { users: [borrowerId] },
  });

  audit(interaction.client, interaction.guildId, `💰 <@${interaction.user.id}> abriu empréstimo para <@${borrowerId}> em <#${thread.id}>.`);
  return interaction.editReply({
    content: `Tópico criado: <#${thread.id}> · ID \`${insertedId}\`. Liste os itens por lá.`,
    components: [],
  });
}

/** Botão "Meus empréstimos". */
async function myLoans(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const rows = await collections
    .loans()
    .find({ borrowerDiscordId: interaction.user.id, status: { $in: ACTIVE_STATUSES } })
    .sort({ dueAt: 1 })
    .toArray();
  if (!rows.length) return interaction.editReply('Você não tem nenhum empréstimo ativo. 👍');
  return interaction.editReply(`Você tem **${rows.length}** empréstimo(s) ativo(s):\n${rows.map(fmtLoan).join('\n')}`);
}

export default {
  data: new SlashCommandBuilder()
    .setName('loan')
    .setDescription('Empréstimos da guilda (esmeraldas/itens)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('new')
        .setDescription('Registra um novo empréstimo')
        .addUserOption((o) => o.setName('user').setDescription('Devedor').setRequired(true))
        .addStringOption((o) =>
          o.setName('type').setDescription('Tipo').setRequired(true).addChoices({ name: 'emeralds', value: 'emeralds' }, { name: 'item', value: 'item' }),
        )
        .addIntegerOption((o) => o.setName('days').setDescription(`Prazo em dias (padrão: ${DEFAULT_LOAN_DAYS})`).setRequired(false).setMinValue(1))
        .addIntegerOption((o) => o.setName('amount').setDescription('Qtd. de esmeraldas (se emeralds)').setRequired(false).setMinValue(1))
        .addStringOption((o) => o.setName('item').setDescription('Descrição do item (se item)').setRequired(false)),
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Lista empréstimos ativos (em aberto e atrasados)')
        .addUserOption((o) => o.setName('user').setDescription('Filtra por devedor').setRequired(false)),
    )
    .addSubcommand((s) => s.setName('repay').setDescription('Marca como pago').addStringOption((o) => o.setName('id').setDescription('ID do empréstimo').setRequired(true)))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancela um empréstimo').addStringOption((o) => o.setName('id').setDescription('ID do empréstimo').setRequired(true)))
    .toJSON(),

  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('loan:');
  },

  async handleComponent(interaction) {
    const action = interaction.customId.split(':')[1];
    if (action === 'mine') return myLoans(interaction);
    if (action === 'new') return promptBorrower(interaction);
    if (action === 'borrower') return openLoanThread(interaction);
  },

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const loans = collections.loans();

    if (sub === 'new') {
      const user = interaction.options.getUser('user', true);
      const type = interaction.options.getString('type', true);
      const days = interaction.options.getInteger('days') ?? DEFAULT_LOAN_DAYS;
      const amount = interaction.options.getInteger('amount');
      const item = interaction.options.getString('item');
      if (type === 'emeralds' && !amount) return interaction.editReply('Informe `amount` para empréstimo de esmeraldas.');
      if (type === 'item' && !item) return interaction.editReply('Informe `item` para empréstimo de item.');

      const linked = await collections.members().findOne({ discordId: user.id });
      const { insertedId } = await loans.insertOne({
        borrowerDiscordId: user.id,
        borrowerUuid: linked?.uuid ?? null,
        type,
        amount: type === 'emeralds' ? amount : null,
        itemDesc: type === 'item' ? item : null,
        createdAt: new Date(),
        dueAt: new Date(Date.now() + days * DAY_MS),
        status: 'open',
        createdBy: interaction.user.id,
        threadId: null,
        dueSoonNotified: false,
        overdueReminders: 0,
        lastReminderAt: null,
      });
      audit(interaction.client, interaction.guildId, `💰 Empréstimo registrado para <@${user.id}> (${type}, ${days}d) por <@${interaction.user.id}>.`);
      return interaction.editReply(`Empréstimo registrado por **${days} dias**. ID: \`${insertedId}\`.`);
    }

    if (sub === 'list') {
      const user = interaction.options.getUser('user');
      const filter = { status: { $in: ACTIVE_STATUSES } };
      if (user) filter.borrowerDiscordId = user.id;
      const rows = await loans.find(filter).sort({ dueAt: 1 }).limit(20).toArray();
      if (!rows.length) return interaction.editReply('Nenhum empréstimo ativo.');
      return interaction.editReply(rows.map(fmtLoan).join('\n'));
    }

    // repay / cancel
    const _id = toObjectId(interaction.options.getString('id', true));
    if (!_id) return interaction.editReply('ID inválido.');

    const status = sub === 'repay' ? 'repaid' : 'cancelled';
    const res = await loans.findOneAndUpdate(
      { _id, status: { $in: ACTIVE_STATUSES } }, // um atrasado também pode ser quitado
      { $set: { status, closedAt: new Date(), closedBy: interaction.user.id } },
    );
    if (!res) return interaction.editReply('Empréstimo não encontrado ou já fechado.');

    // Fecha o tópico junto, se houver.
    if (res.threadId) {
      const thread = await interaction.client.channels.fetch(res.threadId).catch(() => null);
      await thread?.setArchived(true).catch(() => {});
    }

    audit(interaction.client, interaction.guildId, `💰 Empréstimo \`${_id}\` marcado como **${STATUS_LABEL[status]}** por <@${interaction.user.id}>.`);
    return interaction.editReply(`Empréstimo marcado como **${STATUS_LABEL[status]}**.`);
  },
};
