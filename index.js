import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  StreamType,
  VoiceConnectionStatus
} from '@discordjs/voice';
import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ContextMenuCommandBuilder,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';
import ytdl from 'ytdl-core';
import https from 'node:https';

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Mega Bot is alive!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Web server active on port ${PORT}`));

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const DATA_FILE = path.resolve('./data.json');
const BACKUP_DIR = path.resolve('./backups');

function validateConfig() {
  const placeholders = [];
  if (!TOKEN || TOKEN.includes('your_bot_token_here')) placeholders.push('TOKEN');
  if (!CLIENT_ID || CLIENT_ID.includes('your_client_id_here')) placeholders.push('CLIENT_ID');
  if (GUILD_ID && GUILD_ID.includes('your_server_id_here')) placeholders.push('GUILD_ID');

  if (placeholders.length) {
    console.error(`⚠️ Missing or placeholder config values: ${placeholders.join(', ')}.`);
    console.error('Update your .env file with real Discord credentials before starting the bot.');
    return false;
  }

  return true;
}

const configReady = validateConfig();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ]
});

function createDefaultGuildState() {
  return {
    prefix: '>',
    language: 'en',
    welcome: { enabled: false, channelId: null, message: 'Welcome {user} to {server}!' },
    leave: { enabled: false, channelId: null, message: 'Goodbye {user}!' },
    autoRoleId: null,
    modLogChannelId: null,
    ticketChannelId: null,
    announcementsChannelId: null,
    autoMod: { antiLink: true, antiInvite: true, antiSpam: true, antiMentions: true, antiCaps: true, blockedWords: [] },
    blacklist: [],
    shop: [{ name: 'XP Booster', price: 1000, description: 'Boost your next XP gain' }],
    suggestions: [],
    reactionRoles: [],
    logging: { channelId: null }
  };
}

function createDefaultUserState() {
  return {
    balance: 0,
    dailyClaimedAt: 0,
    weeklyClaimedAt: 0,
    monthlyClaimedAt: 0,
    level: 0,
    xp: 0,
    lastXpAt: 0,
    inventory: [],
    warnings: []
  };
}

function createDefaultState() {
  return {
    guilds: {},
    users: {},
    warnings: {},
    tickets: {},
    blacklist: { global: [], servers: {} },
    backups: []
  };
}

function loadState() {
  if (!existsSync(DATA_FILE)) {
    mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    return createDefaultState();
  }

  try {
    const raw = readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...createDefaultState(),
      ...parsed,
      guilds: parsed.guilds || {},
      users: parsed.users || {},
      warnings: parsed.warnings || {},
      tickets: parsed.tickets || {},
      blacklist: parsed.blacklist || { global: [], servers: {} },
      backups: parsed.backups || []
    };
  } catch (error) {
    console.warn('⚠️ Failed to read data file. Starting fresh.', error.message);
    return createDefaultState();
  }
}

let state = loadState();

function saveState() {
  mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function backupState(label = 'manual') {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const fileName = `${Date.now()}-${label}.json`;
  const backupPath = path.join(BACKUP_DIR, fileName);
  writeFileSync(backupPath, JSON.stringify(state, null, 2));
  state.backups.push({ label, fileName, createdAt: new Date().toISOString() });
  saveState();
  return backupPath;
}

function restoreLatestBackup() {
  const backups = state.backups || [];
  if (!backups.length) return null;
  const latest = backups[backups.length - 1];
  const backupPath = path.join(BACKUP_DIR, latest.fileName);
  if (!existsSync(backupPath)) return null;
  const raw = readFileSync(backupPath, 'utf8');
  const parsed = JSON.parse(raw);
  state = {
    ...state,
    ...parsed,
    guilds: parsed.guilds || {},
    users: parsed.users || {},
    warnings: parsed.warnings || {},
    tickets: parsed.tickets || {},
    blacklist: parsed.blacklist || { global: [], servers: {} },
    backups: parsed.backups || []
  };
  saveState();
  return backupPath;
}

function getGuildState(guildId) {
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = createDefaultGuildState();
  }
  return state.guilds[guildId];
}

function getUserState(userId) {
  if (!state.users[userId]) {
    state.users[userId] = createDefaultUserState();
  }
  return state.users[userId];
}

function getPrefix(guildId) {
  return getGuildState(guildId).prefix || '>';
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getReactionKey(emoji) {
  if (!emoji) return null;
  if (typeof emoji === 'string' && emoji.startsWith('<') && emoji.includes(':')) return emoji;
  return emoji.name || emoji.toString();
}

async function sendLog(guildId, embed) {
  const guildState = getGuildState(guildId);
  const channelId = guildState.logging?.channelId;
  if (!channelId) return;
  const channel = client.channels.cache.get(channelId);
  if (channel?.isTextBased()) {
    await channel.send({ embeds: [embed] }).catch(() => null);
  }
}

function parseDuration(value) {
  const match = /^([0-9]+)([smhd])$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * multipliers[unit];
}

function canModerate(member) {
  if (!member) return false;
  return member.permissions.has(PermissionFlagsBits.Administrator)
    || member.permissions.has(PermissionFlagsBits.ManageGuild)
    || member.permissions.has(PermissionFlagsBits.ManageMessages)
    || member.permissions.has(PermissionFlagsBits.ModerateMembers);
}

function getMusicState(guildId) {
  if (!musicStates.has(guildId)) {
    musicStates.set(guildId, { queue: [], connection: null, player: null, textChannel: null, current: null });
  }
  return musicStates.get(guildId);
}

async function stopMusic(guildId) {
  const state = getMusicState(guildId);
  state.queue = [];
  state.current = null;
  if (state.player) {
    state.player.stop();
  }
  if (state.connection) {
    state.connection.destroy();
  }
  state.connection = null;
  state.player = null;
  state.textChannel = null;
  musicStates.delete(guildId);
}

function fetchSpotifyTrack(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        resolve(data);
      });
    });
    request.on('error', reject);
  });
}

async function resolveTrackInfo(input) {
  if (/^(https?:\/\/)/i.test(input)) {
    if (/spotify\.com/i.test(input)) {
      const html = await fetchSpotifyTrack(input);
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/Spotify/i, '').trim() : 'Spotify track';
      return { url: input, title: title || 'Spotify track' };
    }

    const info = await ytdl.getInfo(input);
    return { url: input, title: info.videoDetails.title };
  }

  return { url: input, title: input };
}

async function playNextTrack(guildId) {
  const state = getMusicState(guildId);
  if (!state.queue.length) {
    await stopMusic(guildId);
    return;
  }

  if (!state.connection) return;
  if (!state.player) {
    state.player = createAudioPlayer();
    state.player.on('error', (error) => {
      console.error('Music player error:', error);
      playNextTrack(guildId).catch(() => null);
    });
    state.player.on(AudioPlayerStatus.Idle, () => {
      if (state.queue.length) {
        playNextTrack(guildId).catch(() => null);
      } else {
        setTimeout(() => {
          if (state.player?.state.status === AudioPlayerStatus.Idle) {
            stopMusic(guildId).catch(() => null);
          }
        }, 5000);
      }
    });
  }

  const track = state.queue.shift();
  state.current = track;
  try {
    const stream = ytdl(track.url, { filter: 'audioonly', quality: 'highestaudio', highWaterMark: 1 << 25 });
    const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    state.player.play(resource);
    state.connection.subscribe(state.player);
    if (state.textChannel) {
      await state.textChannel.send(`🎵 Now playing: **${track.title}**`).catch(() => null);
    }
  } catch (error) {
    console.error('Failed to play track:', error);
    if (state.queue.length) {
      await playNextTrack(guildId);
    } else {
      await stopMusic(guildId);
    }
  }
}

async function ensureVoiceConnection(guildId, voiceChannel, textChannel) {
  const state = getMusicState(guildId);
  if (!state.connection || state.connection.state.status === VoiceConnectionStatus.Destroyed) {
    state.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator
    });
    state.connection.on(VoiceConnectionStatus.Disconnected, () => {
      stopMusic(guildId).catch(() => null);
    });
  }
  state.textChannel = textChannel;
  return state;
}

function isBlacklisted(userId, guildId) {
  if (state.blacklist.global.includes(userId)) return true;
  const guildState = getGuildState(guildId);
  return guildState.blacklist.includes(userId);
}

function useCooldown(userId, commandName, seconds = 5) {
  const key = `${userId}:${commandName}`;
  const now = Date.now();
  const expiresAt = cooldowns.get(key);
  if (expiresAt && now < expiresAt) return false;
  cooldowns.set(key, now + seconds * 1000);
  return true;
}

function addXp(member, amount = 10) {
  if (!member?.guild || member.user.bot) return;
  const userState = getUserState(member.id);
  const now = Date.now();
  if (userState.lastXpAt && now - userState.lastXpAt < 60000) return;
  userState.xp += amount;
  userState.lastXpAt = now;
  while (userState.xp >= userState.level * 100 + 100) {
    userState.level += 1;
    userState.xp = Math.max(0, userState.xp - (userState.level - 1) * 100 - 100);
  }
  saveState();
}

function formatDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function buildHelpEmbed(prefix, category = 'all') {
  const base = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🤖 Mega Bot Help')
    .setDescription(`Prefix: ${prefix}\nFeatures: moderation, economy, leveling, welcome, tickets, self-roles, suggestions, fun, announcements, auto-mod, reaction roles, logging, music`);

  switch (category) {
    case 'utility':
      return base.addFields({ name: 'Utility', value: 'ping, help, avatar, userinfo, serverinfo' });
    case 'moderation':
      return base.addFields({ name: 'Moderation', value: 'kick, ban, tempban, softban, warn, unwarn, warnings, mute, unmute, purge, slowmode, nick, lock, unlock' });
    case 'economy':
      return base.addFields({ name: 'Economy & Fun', value: 'balance, daily, weekly, monthly, work, crime, beg, deposit, withdraw, transfer, shop, buy, inventory, coinflip, dice, rps, 8ball' });
    case 'setup':
      return base.addFields({ name: 'Setup', value: 'setup-welcome, setup-leave, set-auto-role, setup-selfrole, setup-tickets, prefix, setlogchannel, addblockword, removeblockword, setup-reactionrole, setlang, backup, restore, announce, suggest, poll, remind, streamremind' });
    case 'music':
      return base.addFields({ name: 'Music', value: 'play, queue, skip, pause, resume, stop' });
    default:
      return base.addFields(
        { name: 'Utility', value: 'ping, help, avatar, userinfo, serverinfo' },
        { name: 'Moderation', value: 'kick, ban, tempban, softban, warn, unwarn, warnings, mute, unmute, purge, slowmode, nick, lock, unlock' },
        { name: 'Economy & Fun', value: 'balance, daily, weekly, monthly, work, crime, beg, deposit, withdraw, transfer, shop, buy, inventory, coinflip, dice, rps, 8ball' },
        { name: 'Setup', value: 'setup-welcome, setup-leave, set-auto-role, setup-selfrole, setup-tickets, prefix, setlogchannel, addblockword, removeblockword, setup-reactionrole, setlang, backup, restore, announce, suggest, poll, remind, streamremind' },
        { name: 'Music', value: 'play, queue, skip, pause, resume, stop' }
      );
  }
}

function buildHelpComponents(selectedCategory = 'all') {
  const categories = [
    { id: 'all', label: 'All', style: ButtonStyle.Primary },
    { id: 'utility', label: 'Utility', style: ButtonStyle.Secondary },
    { id: 'moderation', label: 'Moderation', style: ButtonStyle.Secondary },
    { id: 'economy', label: 'Economy', style: ButtonStyle.Secondary },
    { id: 'setup', label: 'Setup', style: ButtonStyle.Secondary },
    { id: 'music', label: 'Music', style: ButtonStyle.Secondary }
  ];

  return [new ActionRowBuilder().addComponents(
    ...categories.map((category) => new ButtonBuilder()
      .setCustomId(`help:${category.id}`)
      .setLabel(category.label)
      .setStyle(selectedCategory === category.id ? ButtonStyle.Success : category.style))
  )];
}

const cooldowns = new Map();
const reminders = new Map();
const musicStates = new Map();
const aliases = {
  pong: 'ping',
  commands: 'help',
  cmds: 'help',
  bal: 'balance',
  claim: 'daily',
  warning: 'warn',
  clear: 'purge',
  rank: 'level',
  week: 'weekly',
  month: 'monthly'
};

const slashCommands = [
  new SlashCommandBuilder().setName('ping').setDescription('Replies with bot latency'),
  new SlashCommandBuilder().setName('help').setDescription('Shows the bot help menu'),
  new SlashCommandBuilder().setName('avatar').setDescription('Shows a user avatar').addUserOption((opt) => opt.setName('target').setDescription('The user whose avatar you want to see')),
  new SlashCommandBuilder().setName('userinfo').setDescription('Shows a user profile').addUserOption((opt) => opt.setName('target').setDescription('The user whose profile you want to inspect')),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Shows server information'),
  new SlashCommandBuilder().setName('balance').setDescription('Shows your economy balance'),
  new SlashCommandBuilder().setName('daily').setDescription('Claims your daily reward'),
  new SlashCommandBuilder().setName('weekly').setDescription('Claims your weekly reward'),
  new SlashCommandBuilder().setName('monthly').setDescription('Claims your monthly reward'),
  new SlashCommandBuilder().setName('work').setDescription('Work for a small payout'),
  new SlashCommandBuilder().setName('crime').setDescription('Try your luck at crime'),
  new SlashCommandBuilder().setName('beg').setDescription('Ask for a small handout'),
  new SlashCommandBuilder().setName('deposit').setDescription('Deposit coins into your bank'),
  new SlashCommandBuilder().setName('withdraw').setDescription('Withdraw coins from your bank'),
  new SlashCommandBuilder().setName('transfer').setDescription('Transfer coins to another user').addUserOption((opt) => opt.setName('target').setDescription('The user to send coins to').setRequired(true)).addIntegerOption((opt) => opt.setName('amount').setDescription('Amount of coins').setRequired(true)),
  new SlashCommandBuilder().setName('shop').setDescription('Browse the server shop'),
  new SlashCommandBuilder().setName('buy').setDescription('Buy an item from the shop').addStringOption((opt) => opt.setName('item').setDescription('Item to buy').setRequired(true)),
  new SlashCommandBuilder().setName('inventory').setDescription('Shows your inventory'),
  new SlashCommandBuilder().setName('level').setDescription('Shows your current level and XP'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Shows the top members by level'),
  new SlashCommandBuilder().setName('coinflip').setDescription('Flip a coin'),
  new SlashCommandBuilder().setName('dice').setDescription('Roll a die'),
  new SlashCommandBuilder().setName('rps').setDescription('Play rock paper scissors').addStringOption((opt) => opt.setName('choice').setDescription('Your choice').setRequired(true)),
  new SlashCommandBuilder().setName('8ball').setDescription('Ask the magic 8ball').addStringOption((opt) => opt.setName('question').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder().setName('suggest').setDescription('Submit a suggestion').addStringOption((opt) => opt.setName('suggestion').setDescription('Your suggestion').setRequired(true)),
  new SlashCommandBuilder().setName('announce').setDescription('Send an announcement').addStringOption((opt) => opt.setName('message').setDescription('Announcement text').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member').addUserOption((opt) => opt.setName('target').setDescription('The user to kick').setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason for the kick')).setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member').addUserOption((opt) => opt.setName('target').setDescription('The user to ban').setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason for the ban')).setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName('tempban').setDescription('Temporarily ban a member').addUserOption((opt) => opt.setName('target').setDescription('The user to tempban').setRequired(true)).addIntegerOption((opt) => opt.setName('hours').setDescription('Duration in hours').setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason for the tempban')).setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName('softban').setDescription('Soft-ban a member').addUserOption((opt) => opt.setName('target').setDescription('The user to softban').setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason for the softban')).setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName('warn').setDescription('Warn a member').addUserOption((opt) => opt.setName('target').setDescription('The user to warn').setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason for the warning')).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('unwarn').setDescription('Remove a warning').addUserOption((opt) => opt.setName('target').setDescription('The user to clear warnings from').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('warnings').setDescription('List warnings for a member').addUserOption((opt) => opt.setName('target').setDescription('The user to inspect').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('mute').setDescription('Timeout a member').addUserOption((opt) => opt.setName('target').setDescription('The user to timeout').setRequired(true)).addIntegerOption((opt) => opt.setName('minutes').setDescription('Timeout length in minutes').setRequired(true)).addStringOption((opt) => opt.setName('reason').setDescription('Reason for the timeout')).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('unmute').setDescription('Remove a timeout').addUserOption((opt) => opt.setName('target').setDescription('The user to untimeout').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('purge').setDescription('Delete recent messages').addIntegerOption((opt) => opt.setName('amount').setDescription('Number of messages to delete').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName('slowmode').setDescription('Set slowmode').addIntegerOption((opt) => opt.setName('seconds').setDescription('Slowmode seconds').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('nick').setDescription('Change a nickname').addUserOption((opt) => opt.setName('target').setDescription('The user to rename').setRequired(true)).addStringOption((opt) => opt.setName('nickname').setDescription('New nickname').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames),
  new SlashCommandBuilder().setName('lock').setDescription('Lock a channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('unlock').setDescription('Unlock a channel').setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('setup-welcome').setDescription('Configure the welcome channel').addChannelOption((opt) => opt.setName('channel').setDescription('Channel for welcome messages').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setup-leave').setDescription('Configure the leave channel').addChannelOption((opt) => opt.setName('channel').setDescription('Channel for leave messages').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('set-auto-role').setDescription('Set the auto-role').addRoleOption((opt) => opt.setName('role').setDescription('The role to assign on join').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setup-selfrole').setDescription('Create a self-role button').addRoleOption((opt) => opt.setName('role').setDescription('The role to toggle').setRequired(true)).addStringOption((opt) => opt.setName('label').setDescription('Button label').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setup-tickets').setDescription('Deploy a ticket support panel').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('prefix').setDescription('Set a custom prefix for this server').addStringOption((opt) => opt.setName('value').setDescription('The new prefix').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setlogchannel').setDescription('Set the logging channel').addChannelOption((opt) => opt.setName('channel').setDescription('Channel for bot logs').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('poll').setDescription('Create a simple poll').addStringOption((opt) => opt.setName('question').setDescription('Poll question').setRequired(true)).addStringOption((opt) => opt.setName('options').setDescription('Comma-separated options').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('remind').setDescription('Set a reminder').addStringOption((opt) => opt.setName('time').setDescription('Time like 10m, 1h, or 2d').setRequired(true)).addStringOption((opt) => opt.setName('message').setDescription('Reminder text').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('play').setDescription('Play a YouTube track').addStringOption((opt) => opt.setName('url').setDescription('YouTube URL').setRequired(true)),
  new SlashCommandBuilder().setName('queue').setDescription('Show the music queue'),
  new SlashCommandBuilder().setName('skip').setDescription('Skip the current track'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause the current track'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume the current track'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop the music player'),
  new SlashCommandBuilder().setName('streamremind').setDescription('Remind you about a YouTube or Twitch stream').addStringOption((opt) => opt.setName('platform').setDescription('youtube or twitch').setRequired(true)).addStringOption((opt) => opt.setName('name').setDescription('Channel or streamer name').setRequired(true)).addStringOption((opt) => opt.setName('time').setDescription('Time like 10m, 1h, or 2d').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('addblockword').setDescription('Add a blocked word').addStringOption((opt) => opt.setName('word').setDescription('Word to block').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('removeblockword').setDescription('Remove a blocked word').addStringOption((opt) => opt.setName('word').setDescription('Word to remove').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setup-reactionrole').setDescription('Create a reaction-role message').addRoleOption((opt) => opt.setName('role').setDescription('Role to assign').setRequired(true)).addStringOption((opt) => opt.setName('emoji').setDescription('Reaction emoji').setRequired(true)).addStringOption((opt) => opt.setName('label').setDescription('Text shown with the role panel')).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('setlang').setDescription('Set the server language').addStringOption((opt) => opt.setName('language').setDescription('Language code like en or fr').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('backup').setDescription('Create a data backup').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('restore').setDescription('Restore the latest backup').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map((command) => command.toJSON());

const contextMenus = [
  new ContextMenuCommandBuilder().setName('User Info').setType(ApplicationCommandType.User),
  new ContextMenuCommandBuilder().setName('Message Info').setType(ApplicationCommandType.Message)
].map((command) => command.toJSON());

client.once('ready', async () => {
  console.log(`🤖 Mega Bot deployed as ${client.user.tag}`);
  await client.user.setActivity('>help | slash commands', { type: 3 });
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [...slashCommands, ...contextMenus] });
      console.log('✅ Slash and context commands registered for this guild.');
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [...slashCommands, ...contextMenus] });
      console.log('✅ Slash and context commands registered globally.');
    }
  } catch (error) {
    console.error('❌ Failed to register commands.', error);
  }
});

client.on('guildMemberAdd', async (member) => {
  const guildState = getGuildState(member.guild.id);
  if (guildState.autoRoleId) {
    const role = member.guild.roles.cache.get(guildState.autoRoleId);
    if (role) await member.roles.add(role).catch(() => null);
  }

  try {
    const welcomeChannel = guildState.welcome.channelId ? member.guild.channels.cache.get(guildState.welcome.channelId) : member.guild.channels.cache.find((ch) => ch.name.includes('welcome'));
    if (welcomeChannel?.isTextBased()) {
      const message = (guildState.welcome.message || 'Welcome {user} to {server}!').replace('{user}', member.user.tag).replace('{server}', member.guild.name);
      await welcomeChannel.send(message).catch(() => null);
    }
  } catch {}

  await sendLog(member.guild.id, new EmbedBuilder().setColor('#57F287').setTitle('👋 Member Joined').setDescription(`${member.user.tag} joined the server.`));
});

client.on('guildMemberRemove', async (member) => {
  const guildState = getGuildState(member.guild.id);
  const leaveChannel = guildState.leave.channelId ? member.guild.channels.cache.get(guildState.leave.channelId) : member.guild.channels.cache.find((ch) => ch.name.includes('leave'));
  if (leaveChannel?.isTextBased()) {
    const message = (guildState.leave.message || 'Goodbye {user}!').replace('{user}', member.user.tag).replace('{server}', member.guild.name);
    await leaveChannel.send(message);
  }

  await sendLog(member.guild.id, new EmbedBuilder().setColor('#FEE75C').setTitle('👋 Member Left').setDescription(`${member.user.tag} left the server.`));
});

client.on('guildBanAdd', async (ban) => {
  await sendLog(ban.guild.id, new EmbedBuilder().setColor('#ED4245').setTitle('🔨 Member Banned').setDescription(`${ban.user.tag} was banned.`).setTimestamp());
});

client.on('guildBanRemove', async (ban) => {
  await sendLog(ban.guild.id, new EmbedBuilder().setColor('#57F287').setTitle('✅ Member Unbanned').setDescription(`${ban.user.tag} was unbanned.`).setTimestamp());
});

client.on('messageDelete', async (message) => {
  if (!message.guild || message.author?.bot) return;
  await sendLog(message.guild.id, new EmbedBuilder().setColor('#FEE75C').setTitle('🗑️ Message Deleted').setDescription(`A message by ${message.author.tag} was deleted.\n\n${message.content || 'No content'}`).setTimestamp());
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || !reaction.message.guild) return;
  const guildState = getGuildState(reaction.message.guild.id);
  const match = guildState.reactionRoles.find((entry) => entry.messageId === reaction.message.id && entry.channelId === reaction.message.channel.id);
  if (!match) return;
  const emojiKey = getReactionKey(reaction.emoji);
  if (!emojiKey || emojiKey !== match.emoji) return;
  const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
  const role = reaction.message.guild.roles.cache.get(match.roleId);
  if (member && role) await member.roles.add(role).catch(() => null);
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot || !reaction.message.guild) return;
  const guildState = getGuildState(reaction.message.guild.id);
  const match = guildState.reactionRoles.find((entry) => entry.messageId === reaction.message.id && entry.channelId === reaction.message.channel.id);
  if (!match) return;
  const emojiKey = getReactionKey(reaction.emoji);
  if (!emojiKey || emojiKey !== match.emoji) return;
  const member = await reaction.message.guild.members.fetch(user.id).catch(() => null);
  const role = reaction.message.guild.roles.cache.get(match.roleId);
  if (member && role) await member.roles.remove(role).catch(() => null);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const guildState = getGuildState(message.guild.id);
  if (isBlacklisted(message.author.id, message.guild.id)) return;

  const content = message.content;
  const isModerator = message.member?.permissions.has(PermissionFlagsBits.Administrator)
    || message.member?.permissions.has(PermissionFlagsBits.ManageGuild)
    || message.member?.permissions.has(PermissionFlagsBits.ManageMessages);

  const blockedWords = guildState.autoMod.blockedWords || [];
  const matchedBlockedWord = blockedWords.find((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(content));
  if (matchedBlockedWord && !isModerator) {
    await message.delete().catch(() => null);
    return;
  }

  const letters = (content.match(/[A-Za-z]/g) || []).length;
  const uppercaseLetters = (content.match(/[A-Z]/g) || []).length;
  if (guildState.autoMod.antiCaps && letters >= 12 && uppercaseLetters / letters > 0.7 && !isModerator) {
    await message.delete().catch(() => null);
    return;
  }

  if (content.includes('http://') || content.includes('https://') || content.includes('discord.gg/')) {
    if (!guildState.autoMod.antiLink || isModerator) return;
    try {
      await message.delete();
      const warning = await message.channel.send(`⚠️ ${message.author}, links are not allowed here.`);
      setTimeout(() => warning.delete().catch(() => null), 5000);
    } catch {}
  }

  if (guildState.autoMod.antiInvite && /(discord\.gg|discordapp\.com\/invite|discord\.com\/invite)/i.test(content)) {
    if (!isModerator) {
      await message.delete().catch(() => null);
      return;
    }
  }

  if (guildState.autoMod.antiMentions && message.mentions.users.size > 3) {
    if (!isModerator) {
      await message.delete().catch(() => null);
      return;
    }
  }

  if (guildState.autoMod.antiSpam && content.split(/\s+/).length > 14) {
    if (!isModerator) {
      await message.delete().catch(() => null);
      return;
    }
  }

  const prefix = getPrefix(message.guild.id);
  const normalizedPrefix = prefix.toLowerCase();
  const normalizedContent = message.content.toLowerCase();
  const hasPrefix = normalizedContent.startsWith(normalizedPrefix);

  if (!hasPrefix) {
    addXp(message.member, 10);
    return;
  }

  const commandContent = message.content.slice(prefix.length).trim();
  if (!commandContent) return;

  const [rawCommand, ...args] = commandContent.split(/\s+/);
  const commandName = (rawCommand || '').toLowerCase();
  const resolvedCommand = aliases[commandName] || commandName;
  if (!resolvedCommand) return;
  if (!useCooldown(message.author.id, resolvedCommand, 3)) {
    return message.reply('⏳ Please wait a moment before using that command again.');
  }

  try {
    switch (resolvedCommand) {
      case 'ping':
        await message.reply(`🏓 Pong! Latency is ${client.ws.ping}ms.`);
        break;
      case 'help': {
        const embed = new EmbedBuilder()
          .setColor('#5865F2')
          .setTitle('🤖 Mega Bot Help')
          .setDescription(`Prefix: ${prefix}\nFeatures: moderation, economy, leveling, welcome, tickets, self-roles, suggestions, fun, announcements, auto-mod, reaction roles, logging`)
          .addFields(
            { name: 'Utility', value: 'ping, help, avatar, userinfo, serverinfo' },
            { name: 'Moderation', value: 'kick, ban, tempban, softban, warn, unwarn, warnings, mute, unmute, purge, slowmode, nick, lock, unlock' },
            { name: 'Economy & Fun', value: 'balance, daily, weekly, monthly, work, crime, beg, deposit, withdraw, transfer, shop, buy, inventory, coinflip, dice, rps, 8ball' },
            { name: 'Setup', value: 'setup-welcome, setup-leave, set-auto-role, setup-selfrole, setup-tickets, prefix, setlogchannel, addblockword, removeblockword, setup-reactionrole, setlang, backup, restore, announce, suggest' }
          );
        await message.reply({ embeds: [embed] });
        break;
      }
      case 'avatar': {
        const target = message.mentions.users.first() || message.author;
        await message.reply({ embeds: [new EmbedBuilder().setColor('#57F287').setTitle(`${target.username}'s Avatar`).setImage(target.displayAvatarURL({ size: 256 }))] });
        break;
      }
      case 'userinfo': {
        const target = message.mentions.users.first() || message.author;
        const member = message.guild.members.cache.get(target.id);
        const embed = new EmbedBuilder().setColor('#57F287').setTitle(`User Info: ${target.tag}`).setDescription(`ID: ${target.id}`).addFields(
          { name: 'Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:R>` },
          { name: 'Joined', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown' }
        );
        await message.reply({ embeds: [embed] });
        break;
      }
      case 'serverinfo': {
        const embed = new EmbedBuilder().setColor('#FEE75C').setTitle(`${message.guild.name}`).setDescription(`Members: ${message.guild.memberCount}\nOwner: <@${message.guild.ownerId}>`);
        await message.reply({ embeds: [embed] });
        break;
      }
      case 'balance': {
        const userState = getUserState(message.author.id);
        await message.reply(`💰 Your balance is **${userState.balance}** coins.`);
        break;
      }
      case 'daily': {
        const userState = getUserState(message.author.id);
        const now = Date.now();
        if (userState.dailyClaimedAt && now - userState.dailyClaimedAt < 86400000) {
          await message.reply('🎁 You already claimed your daily reward today.');
          break;
        }
        userState.balance += 500;
        userState.dailyClaimedAt = now;
        saveState();
        await message.reply('🎁 You claimed your daily reward of **500** coins.');
        break;
      }
      case 'weekly': {
        const userState = getUserState(message.author.id);
        const now = Date.now();
        if (userState.weeklyClaimedAt && now - userState.weeklyClaimedAt < 7 * 86400000) {
          await message.reply('🎁 You already claimed your weekly reward.');
          break;
        }
        userState.balance += 2000;
        userState.weeklyClaimedAt = now;
        saveState();
        await message.reply('🎁 You claimed your weekly reward of **2000** coins.');
        break;
      }
      case 'monthly': {
        const userState = getUserState(message.author.id);
        const now = Date.now();
        if (userState.monthlyClaimedAt && now - userState.monthlyClaimedAt < 30 * 86400000) {
          await message.reply('🎁 You already claimed your monthly reward.');
          break;
        }
        userState.balance += 10000;
        userState.monthlyClaimedAt = now;
        saveState();
        await message.reply('🎁 You claimed your monthly reward of **10000** coins.');
        break;
      }
      case 'work': {
        const userState = getUserState(message.author.id);
        const payout = 120 + Math.floor(Math.random() * 80);
        userState.balance += payout;
        saveState();
        await message.reply(`💼 You worked hard and earned **${payout}** coins.`);
        break;
      }
      case 'crime': {
        const userState = getUserState(message.author.id);
        const success = Math.random() > 0.4;
        if (success) {
          const payout = 200 + Math.floor(Math.random() * 150);
          userState.balance += payout;
          saveState();
          await message.reply(`🕵️ You pulled off a heist and earned **${payout}** coins.`);
        } else {
          userState.balance = Math.max(0, userState.balance - 100);
          saveState();
          await message.reply('🚨 Your crime attempt failed and you lost **100** coins.');
        }
        break;
      }
      case 'beg': {
        const payout = 50 + Math.floor(Math.random() * 50);
        const userState = getUserState(message.author.id);
        userState.balance += payout;
        saveState();
        await message.reply(`🧡 Someone felt sorry for you and gave **${payout}** coins.`);
        break;
      }
      case 'deposit': {
        const amount = Number.parseInt(args[0], 10);
        const userState = getUserState(message.author.id);
        if (!amount || amount < 1) return message.reply('⚠️ Use >deposit amount');
        if (userState.balance < amount) return message.reply('⚠️ You do not have enough coins.');
        userState.balance -= amount;
        userState.bank = (userState.bank || 0) + amount;
        saveState();
        await message.reply(`🏦 Deposited **${amount}** coins into your bank.`);
        break;
      }
      case 'withdraw': {
        const amount = Number.parseInt(args[0], 10);
        const userState = getUserState(message.author.id);
        if (!amount || amount < 1) return message.reply('⚠️ Use >withdraw amount');
        const bank = userState.bank || 0;
        if (bank < amount) return message.reply('⚠️ You do not have enough coins in your bank.');
        userState.bank -= amount;
        userState.balance += amount;
        saveState();
        await message.reply(`🏦 Withdrew **${amount}** coins from your bank.`);
        break;
      }
      case 'transfer': {
        const target = message.mentions.users.first();
        const amount = Number.parseInt(args[1], 10);
        if (!target || !amount) return message.reply('⚠️ Use >transfer @user amount');
        const userState = getUserState(message.author.id);
        const targetState = getUserState(target.id);
        if (userState.balance < amount) return message.reply('⚠️ You do not have enough coins.');
        userState.balance -= amount;
        targetState.balance += amount;
        saveState();
        await message.reply(`💸 Transferred **${amount}** coins to ${target.tag}.`);
        break;
      }
      case 'shop': {
        const items = (guildState.shop || []).map((item, index) => `${index + 1}. ${item.name} — ${item.price} coins (${item.description})`).join('\n');
        await message.reply(`🛍️ Shop\n${items || 'No items yet.'}`);
        break;
      }
      case 'buy': {
        const itemName = args.join(' ');
        const item = (guildState.shop || []).find((entry) => entry.name.toLowerCase() === itemName.toLowerCase());
        if (!item) return message.reply('⚠️ Item not found.');
        const userState = getUserState(message.author.id);
        if (userState.balance < item.price) return message.reply('⚠️ You do not have enough coins.');
        userState.balance -= item.price;
        userState.inventory.push(item.name);
        saveState();
        await message.reply(`🛍️ You bought **${item.name}**.`);
        break;
      }
      case 'inventory': {
        const userState = getUserState(message.author.id);
        await message.reply(`🎒 Inventory: ${userState.inventory.length ? userState.inventory.join(', ') : 'empty'}`);
        break;
      }
      case 'level': {
        const userState = getUserState(message.author.id);
        await message.reply(`📈 You are level **${userState.level}** with **${userState.xp}** XP.`);
        break;
      }
      case 'leaderboard': {
        const sorted = Object.entries(state.users).sort((a, b) => (b[1].level || 0) - (a[1].level || 0)).slice(0, 10);
        const lines = sorted.map(([id, data], index) => `${index + 1}. <@${id}> — Level ${data.level} (${data.xp} XP)`).join('\n');
        await message.reply(`🏆 Leaderboard\n${lines || 'No data yet.'}`);
        break;
      }
      case 'coinflip': {
        await message.reply(Math.random() > 0.5 ? '🪙 Heads' : '🪙 Tails');
        break;
      }
      case 'dice': {
        await message.reply(`🎲 You rolled a **${1 + Math.floor(Math.random() * 6)}**.`);
        break;
      }
      case 'rps': {
        const choices = ['rock', 'paper', 'scissors'];
        const botChoice = choices[Math.floor(Math.random() * choices.length)];
        const userChoice = (args[0] || '').toLowerCase();
        if (!choices.includes(userChoice)) return message.reply('⚠️ Choose rock, paper, or scissors.');
        const result = userChoice === botChoice ? 'Tie' : ((userChoice === 'rock' && botChoice === 'scissors') || (userChoice === 'paper' && botChoice === 'rock') || (userChoice === 'scissors' && botChoice === 'paper') ? 'You win' : 'Bot wins');
        await message.reply(`🪨✋✂️ Bot chose **${botChoice}** — **${result}**.`);
        break;
      }
      case '8ball': {
        const answers = ['Yes', 'No', 'Definitely', 'Ask again later', 'Probably', 'Absolutely not'];
        await message.reply(`🎱 ${answers[Math.floor(Math.random() * answers.length)]}`);
        break;
      }
      case 'suggest': {
        const suggestion = args.join(' ');
        if (!suggestion) return message.reply('⚠️ Please provide a suggestion.');
        guildState.suggestions.push({ userId: message.author.id, text: suggestion, createdAt: new Date().toISOString() });
        saveState();
        await message.reply('💡 Your suggestion was recorded.');
        break;
      }
      case 'announce': {
        const announcement = args.join(' ');
        if (!announcement) return message.reply('⚠️ Please provide a message.');
        const channel = guildState.announcementsChannelId ? message.guild.channels.cache.get(guildState.announcementsChannelId) : message.channel;
        if (!channel?.isTextBased()) return message.reply('⚠️ No announcement channel configured.');
        await channel.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('📢 Announcement').setDescription(announcement)] });
        await message.reply('📢 Announcement sent.');
        break;
      }
      case 'kick': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const target = message.mentions.members?.first();
        if (!target) return message.reply('⚠️ Please mention a user to kick.');
        if (!target.kickable) return message.reply('❌ I cannot kick that user.');
        const reason = args.slice(1).join(' ') || 'No reason provided';
        await target.kick(reason);
        await message.reply(`👮 ${target.user.tag} was kicked. Reason: ${reason}`);
        break;
      }
      case 'ban': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const target = message.mentions.members?.first();
        if (!target) return message.reply('⚠️ Please mention a user to ban.');
        const reason = args.slice(1).join(' ') || 'No reason provided';
        await target.ban({ reason });
        await message.reply(`🔨 ${target.user.tag} was banned. Reason: ${reason}`);
        break;
      }
      case 'tempban': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const target = message.mentions.members?.first();
        const hours = Number.parseInt(args[1], 10);
        if (!target || !hours) return message.reply('⚠️ Use: >tempban @user hours');
        const reason = args.slice(2).join(' ') || 'No reason provided';
        await target.ban({ reason });
        setTimeout(() => message.guild.members.unban(target.id).catch(() => null), hours * 60 * 60 * 1000);
        await message.reply(`⏳ ${target.user.tag} was banned for ${hours} hours.`);
        break;
      }
      case 'softban': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const target = message.mentions.members?.first();
        if (!target) return message.reply('⚠️ Please mention a user to softban.');
        const reason = args.slice(1).join(' ') || 'No reason provided';
        await target.ban({ deleteMessageSeconds: 60 * 60 * 24, reason });
        await message.guild.members.unban(target.id).catch(() => null);
        await message.reply(`🧹 ${target.user.tag} was soft-banned. Reason: ${reason}`);
        break;
      }
      case 'warn': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const target = message.mentions.members?.first();
        if (!target) return message.reply('⚠️ Please mention a user to warn.');
        const reason = args.slice(1).join(' ') || 'No reason provided';
        const userState = getUserState(target.id);
        userState.warnings.push({ moderator: message.author.id, reason, createdAt: new Date().toISOString() });
        saveState();
        await message.reply(`⚠️ ${target.user.tag} has been warned. Reason: ${reason}`);
        break;
      }
      case 'unwarn': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const target = message.mentions.members?.first();
        if (!target) return message.reply('⚠️ Please mention a user to unwarn.');
        const userState = getUserState(target.id);
        userState.warnings.pop();
        saveState();
        await message.reply(`🧼 Removed the latest warning for ${target.user.tag}.`);
        break;
      }
      case 'warnings': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const target = message.mentions.members?.first();
        if (!target) return message.reply('⚠️ Please mention a user to inspect.');
        const userState = getUserState(target.id);
        const entries = userState.warnings.map((warning, index) => `${index + 1}. ${warning.reason}`).join('\n') || 'No warnings';
        await message.reply(`⚠️ Warnings for ${target.user.tag}:\n${entries}`);
        break;
      }
      case 'mute': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const target = message.mentions.members?.first();
        const minutes = Number.parseInt(args[1], 10);
        if (!target || !minutes) return message.reply('⚠️ Use: >mute @user minutes');
        const reason = args.slice(2).join(' ') || 'No reason provided';
        await target.timeout(minutes * 60 * 1000, reason);
        await message.reply(`⏱️ ${target.user.tag} was timed out for ${minutes} minutes.`);
        break;
      }
      case 'unmute': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const target = message.mentions.members?.first();
        if (!target) return message.reply('⚠️ Please mention a user to unmute.');
        await target.timeout(null);
        await message.reply(`✅ ${target.user.tag} was untimed out.`);
        break;
      }
      case 'purge': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const amount = Number.parseInt(args[0], 10);
        if (!amount || amount < 1 || amount > 100) return message.reply('⚠️ Use a number between 1 and 100.');
        const deleted = await message.channel.bulkDelete(amount, true);
        await message.reply(`🧹 Deleted ${deleted.size} messages.`);
        break;
      }
      case 'slowmode': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const seconds = Number.parseInt(args[0], 10);
        if (!seconds || seconds < 0 || seconds > 21600) return message.reply('⚠️ Use a number between 0 and 21600.');
        await message.channel.setRateLimitPerUser(seconds);
        await message.reply(`⏱️ Slowmode set to ${seconds} seconds.`);
        break;
      }
      case 'nick': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        const target = message.mentions.members?.first();
        const nickname = args.slice(1).join(' ');
        if (!target || !nickname) return message.reply('⚠️ Use >nick @user nickname');
        await target.setNickname(nickname);
        await message.reply(`📝 Updated ${target.user.tag}'s nickname.`);
        break;
      }
      case 'lock': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        await message.channel.permissionOverwrites.edit(message.guild.id, { SendMessages: false }).catch(() => null);
        await message.reply('🔒 Channel locked.');
        break;
      }
      case 'unlock': {
        if (!canModerate(message.member)) return message.reply('❌ You do not have permission to use this command.');
        await message.channel.permissionOverwrites.edit(message.guild.id, { SendMessages: null }).catch(() => null);
        await message.reply('🔓 Channel unlocked.');
        break;
      }
      case 'setup-welcome': {
        const channel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]) || message.guild.channels.cache.find((ch) => ch.name.toLowerCase() === (args[0] || '').toLowerCase());
        if (!channel?.isTextBased()) return message.reply('⚠️ Please mention or provide a valid text channel.');
        getGuildState(message.guild.id).welcome.channelId = channel.id;
        saveState();
        await message.reply(`✅ Welcome channel set to ${channel}.`);
        break;
      }
      case 'setup-leave': {
        const channel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]) || message.guild.channels.cache.find((ch) => ch.name.toLowerCase() === (args[0] || '').toLowerCase());
        if (!channel?.isTextBased()) return message.reply('⚠️ Please mention or provide a valid text channel.');
        getGuildState(message.guild.id).leave.channelId = channel.id;
        saveState();
        await message.reply(`✅ Leave channel set to ${channel}.`);
        break;
      }
      case 'set-auto-role': {
        const role = message.mentions.roles.first() || message.guild.roles.cache.get(args[0]) || message.guild.roles.cache.find((entry) => entry.name.toLowerCase() === (args[0] || '').toLowerCase());
        if (!role) return message.reply('⚠️ Please mention or provide a valid role.');
        getGuildState(message.guild.id).autoRoleId = role.id;
        saveState();
        await message.reply(`✅ Auto-role set to ${role}.`);
        break;
      }
      case 'setup-selfrole': {
        const role = message.mentions.roles.first() || message.guild.roles.cache.get(args[0]) || message.guild.roles.cache.find((entry) => entry.name.toLowerCase() === (args[0] || '').toLowerCase());
        const label = args.slice(1).join(' ') || 'Claim role';
        if (!role) return message.reply('⚠️ Please mention or provide a valid role.');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`selfrole:${role.id}`).setLabel(label).setStyle(ButtonStyle.Primary)
        );
        await message.reply('✅ Self-role panel created.');
        await message.channel.send({ content: `Click below to toggle **${role.name}**`, components: [row] });
        break;
      }
      case 'setup-tickets': {
        const embed = new EmbedBuilder().setColor('#FF5555').setTitle('🎫 Help & Support Tickets').setDescription('Click the button below to open a private support room.');
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('Create Ticket').setStyle(ButtonStyle.Danger).setEmoji('📩'));
        await message.reply('✅ Ticket panel created.');
        await message.channel.send({ embeds: [embed], components: [row] });
        break;
      }
      case 'setlogchannel': {
        const channel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]) || message.guild.channels.cache.find((entry) => entry.name.toLowerCase() === (args[0] || '').toLowerCase());
        if (!channel?.isTextBased()) return message.reply('⚠️ Please mention or provide a valid text channel.');
        getGuildState(message.guild.id).logging.channelId = channel.id;
        saveState();
        await message.reply(`✅ Logging channel set to ${channel}.`);
        break;
      }
      case 'poll': {
        const question = args[0];
        const options = args.slice(1).join(' ').split(',').map((entry) => entry.trim()).filter(Boolean);
        if (!question || options.length < 2) return message.reply('⚠️ Use >poll "Question" "Option1,Option2,Option3"');
        const pollMessage = await message.channel.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('📊 Poll').setDescription(question).addFields(options.map((option, index) => ({ name: `${index + 1}. ${option}`, value: '⬜', inline: false }))) ] });
        const emojiList = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
        for (let index = 0; index < Math.min(options.length, emojiList.length); index += 1) {
          await pollMessage.react(emojiList[index]).catch(() => null);
        }
        await message.reply('✅ Poll created.');
        break;
      }
      case 'remind': {
        const duration = parseDuration(args[0]);
        const reminderText = args.slice(1).join(' ');
        if (!duration || !reminderText) return message.reply('⚠️ Use >remind 10m message');
        const timeoutId = setTimeout(async () => {
          try {
            await message.author.send(`⏰ Reminder: ${reminderText}`);
          } catch {}
          reminders.delete(timeoutId);
        }, duration);
        reminders.set(timeoutId, { userId: message.author.id, createdAt: Date.now() });
        await message.reply(`✅ Reminder set for ${args[0]}.`);
        break;
      }
      case 'streamremind': {
        const platform = (args[0] || '').toLowerCase();
        const name = args[1];
        const duration = parseDuration(args[2]);
        if (!['youtube', 'twitch'].includes(platform) || !name || !duration) return message.reply('⚠️ Use >streamremind youtube|twitch name 10m');
        const timeoutId = setTimeout(async () => {
          try {
            await message.author.send(`📺 Reminder: ${name} on ${platform} is starting soon.`);
          } catch {}
          reminders.delete(timeoutId);
        }, duration);
        reminders.set(timeoutId, { userId: message.author.id, createdAt: Date.now(), platform, name });
        await message.reply(`✅ Stream reminder set for ${name} on ${platform}.`);
        break;
      }
      case 'addblockword': {
        const word = args[0];
        if (!word) return message.reply('⚠️ Please provide a word to block.');
        const guildState = getGuildState(message.guild.id);
        guildState.autoMod.blockedWords = Array.from(new Set([...(guildState.autoMod.blockedWords || []), word.toLowerCase()]));
        saveState();
        await message.reply(`✅ Added **${word}** to the blocked words list.`);
        break;
      }
      case 'removeblockword': {
        const word = args[0];
        if (!word) return message.reply('⚠️ Please provide a word to remove.');
        const guildState = getGuildState(message.guild.id);
        guildState.autoMod.blockedWords = (guildState.autoMod.blockedWords || []).filter((entry) => entry.toLowerCase() !== word.toLowerCase());
        saveState();
        await message.reply(`✅ Removed **${word}** from the blocked words list.`);
        break;
      }
      case 'setup-reactionrole': {
        const role = message.mentions.roles.first() || message.guild.roles.cache.get(args[0]) || message.guild.roles.cache.find((entry) => entry.name.toLowerCase() === (args[0] || '').toLowerCase());
        const emoji = args[1];
        const label = args.slice(2).join(' ') || role?.name || 'Claim role';
        if (!role || !emoji) return message.reply('⚠️ Use >setup-reactionrole @role emoji label');
        const panelMessage = await message.channel.send({ content: `${label}\nReact with ${emoji} to get **${role.name}**.` });
        await panelMessage.react(emoji).catch(() => null);
        getGuildState(message.guild.id).reactionRoles.push({ messageId: panelMessage.id, channelId: panelMessage.channel.id, roleId: role.id, emoji: getReactionKey(emoji) });
        saveState();
        await message.reply('✅ Reaction-role panel created.');
        break;
      }
      case 'play': {
        const trackUrl = args[0];
        if (!trackUrl) return message.reply('⚠️ Use >play <youtube-url-or-spotify-url>');
        if (!message.member?.voice?.channel) return message.reply('⚠️ Join a voice channel first.');
        try {
          const track = await resolveTrackInfo(trackUrl);
          const state = await ensureVoiceConnection(message.guild.id, message.member.voice.channel, message.channel);
          state.queue.push(track);
          if (!state.player || state.player.state.status === AudioPlayerStatus.Idle) {
            await playNextTrack(message.guild.id);
          } else {
            await message.reply(`🎵 Added **${track.title}** to the queue.`);
          }
        } catch (error) {
          console.error(error);
          await message.reply('⚠️ I could not play that track. Please use a valid YouTube or Spotify URL.');
        }
        break;
      }
      case 'queue': {
        const state = getMusicState(message.guild.id);
        if (!state.current && !state.queue.length) return message.reply('🎵 The queue is empty.');
        const lines = [state.current ? `Now playing: ${state.current.title}` : 'Now playing: nothing', ...state.queue.slice(0, 10).map((entry, index) => `${index + 1}. ${entry.title}`)];
        await message.reply(`🎵 Queue\n${lines.join('\n')}`);
        break;
      }
      case 'skip': {
        const state = getMusicState(message.guild.id);
        if (!state.player) return message.reply('🎵 Nothing is playing right now.');
        state.player.stop();
        await message.reply('⏭️ Skipped the current track.');
        break;
      }
      case 'pause': {
        const state = getMusicState(message.guild.id);
        if (!state.player) return message.reply('🎵 Nothing is playing right now.');
        state.player.pause();
        await message.reply('⏸️ Paused the music.');
        break;
      }
      case 'resume': {
        const state = getMusicState(message.guild.id);
        if (!state.player) return message.reply('🎵 Nothing is playing right now.');
        state.player.unpause();
        await message.reply('▶️ Resumed the music.');
        break;
      }
      case 'stop': {
        await stopMusic(message.guild.id);
        await message.reply('🛑 Stopped the music player.');
        break;
      }
      case 'prefix': {
        const newPrefix = args[0];
        if (!newPrefix) return message.reply('⚠️ Please provide a prefix.');
        getGuildState(message.guild.id).prefix = newPrefix;
        saveState();
        await message.reply(`✅ Prefix updated to **${newPrefix}**.`);
        break;
      }
      case 'setlang': {
        const lang = args[0];
        if (!lang) return message.reply('⚠️ Please provide a language code.');
        getGuildState(message.guild.id).language = lang;
        saveState();
        await message.reply(`✅ Language updated to **${lang}**.`);
        break;
      }
      case 'backup': {
        const backupPath = backupState('manual');
        await message.reply(`💾 Backup created at **${path.basename(backupPath)}**.`);
        break;
      }
      case 'restore': {
        const restored = restoreLatestBackup();
        await message.reply(restored ? '✅ Backup restored successfully.' : '⚠️ No backup found to restore.');
        break;
      }
      default:
        await message.reply('❓ Unknown command.');
    }
  } catch (error) {
    console.error(error);
    await message.reply('⚠️ An unexpected error occurred.');
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (isBlacklisted(interaction.user.id, interaction.guildId)) {
      return interaction.reply({ content: '🚫 You are blacklisted from using this bot.', ephemeral: true });
    }

    const { commandName } = interaction;
    if (!useCooldown(interaction.user.id, commandName, 3)) {
      return interaction.reply({ content: '⏳ Please wait a moment before using that command again.', ephemeral: true });
    }

    try {
      switch (commandName) {
        case 'ping':
          await interaction.reply(`🏓 Pong! Latency is ${client.ws.ping}ms.`);
          break;
        case 'help': {
          const guildState = getGuildState(interaction.guild.id);
          const embed = buildHelpEmbed(guildState.prefix);
          await interaction.reply({ embeds: [embed], components: buildHelpComponents() });
          break;
        }
        case 'avatar': {
          const target = interaction.options.getUser('target') || interaction.user;
          await interaction.reply({ embeds: [new EmbedBuilder().setColor('#57F287').setTitle(`${target.username}'s Avatar`).setImage(target.displayAvatarURL({ size: 256 }))] });
          break;
        }
        case 'userinfo': {
          const target = interaction.options.getUser('target') || interaction.user;
          const member = interaction.guild.members.cache.get(target.id);
          const embed = new EmbedBuilder().setColor('#57F287').setTitle(`User Info: ${target.tag}`).setDescription(`ID: ${target.id}`).addFields(
            { name: 'Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:R>` },
            { name: 'Joined', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown' }
          );
          await interaction.reply({ embeds: [embed] });
          break;
        }
        case 'serverinfo': {
          const embed = new EmbedBuilder().setColor('#FEE75C').setTitle(interaction.guild.name).setDescription(`Members: ${interaction.guild.memberCount}\nOwner: <@${interaction.guild.ownerId}>`);
          await interaction.reply({ embeds: [embed] });
          break;
        }
        case 'balance': {
          const userState = getUserState(interaction.user.id);
          await interaction.reply(`💰 Your balance is **${userState.balance}** coins.`);
          break;
        }
        case 'daily': {
          const userState = getUserState(interaction.user.id);
          const now = Date.now();
          if (userState.dailyClaimedAt && now - userState.dailyClaimedAt < 86400000) {
            await interaction.reply('🎁 You already claimed your daily reward today.');
            break;
          }
          userState.balance += 500;
          userState.dailyClaimedAt = now;
          saveState();
          await interaction.reply('🎁 You claimed your daily reward of **500** coins.');
          break;
        }
        case 'weekly': {
          const userState = getUserState(interaction.user.id);
          const now = Date.now();
          if (userState.weeklyClaimedAt && now - userState.weeklyClaimedAt < 7 * 86400000) {
            await interaction.reply('🎁 You already claimed your weekly reward.');
            break;
          }
          userState.balance += 2000;
          userState.weeklyClaimedAt = now;
          saveState();
          await interaction.reply('🎁 You claimed your weekly reward of **2000** coins.');
          break;
        }
        case 'monthly': {
          const userState = getUserState(interaction.user.id);
          const now = Date.now();
          if (userState.monthlyClaimedAt && now - userState.monthlyClaimedAt < 30 * 86400000) {
            await interaction.reply('🎁 You already claimed your monthly reward.');
            break;
          }
          userState.balance += 10000;
          userState.monthlyClaimedAt = now;
          saveState();
          await interaction.reply('🎁 You claimed your monthly reward of **10000** coins.');
          break;
        }
        case 'work': {
          const userState = getUserState(interaction.user.id);
          const payout = 120 + Math.floor(Math.random() * 80);
          userState.balance += payout;
          saveState();
          await interaction.reply(`💼 You worked hard and earned **${payout}** coins.`);
          break;
        }
        case 'crime': {
          const userState = getUserState(interaction.user.id);
          const success = Math.random() > 0.4;
          if (success) {
            const payout = 200 + Math.floor(Math.random() * 150);
            userState.balance += payout;
            saveState();
            await interaction.reply(`🕵️ You pulled off a heist and earned **${payout}** coins.`);
          } else {
            userState.balance = Math.max(0, userState.balance - 100);
            saveState();
            await interaction.reply('🚨 Your crime attempt failed and you lost **100** coins.');
          }
          break;
        }
        case 'beg': {
          const payout = 50 + Math.floor(Math.random() * 50);
          const userState = getUserState(interaction.user.id);
          userState.balance += payout;
          saveState();
          await interaction.reply(`🧡 Someone felt sorry for you and gave **${payout}** coins.`);
          break;
        }
        case 'deposit': {
          const amount = interaction.options.getInteger('amount');
          const userState = getUserState(interaction.user.id);
          if (!amount || amount < 1) return interaction.reply({ content: '⚠️ Use a positive value.', ephemeral: true });
          if (userState.balance < amount) return interaction.reply({ content: '⚠️ You do not have enough coins.', ephemeral: true });
          userState.balance -= amount;
          userState.bank = (userState.bank || 0) + amount;
          saveState();
          await interaction.reply(`🏦 Deposited **${amount}** coins into your bank.`);
          break;
        }
        case 'withdraw': {
          const amount = interaction.options.getInteger('amount');
          const userState = getUserState(interaction.user.id);
          if (!amount || amount < 1) return interaction.reply({ content: '⚠️ Use a positive value.', ephemeral: true });
          const bank = userState.bank || 0;
          if (bank < amount) return interaction.reply({ content: '⚠️ You do not have enough coins in your bank.', ephemeral: true });
          userState.bank -= amount;
          userState.balance += amount;
          saveState();
          await interaction.reply(`🏦 Withdrew **${amount}** coins from your bank.`);
          break;
        }
        case 'transfer': {
          const target = interaction.options.getUser('target');
          const amount = interaction.options.getInteger('amount');
          if (!target || !amount) return interaction.reply({ content: '⚠️ Use a valid target and amount.', ephemeral: true });
          const userState = getUserState(interaction.user.id);
          const targetState = getUserState(target.id);
          if (userState.balance < amount) return interaction.reply({ content: '⚠️ You do not have enough coins.', ephemeral: true });
          userState.balance -= amount;
          targetState.balance += amount;
          saveState();
          await interaction.reply(`💸 Transferred **${amount}** coins to ${target.tag}.`);
          break;
        }
        case 'shop': {
          const items = (getGuildState(interaction.guild.id).shop || []).map((item, index) => `${index + 1}. ${item.name} — ${item.price} coins (${item.description})`).join('\n');
          await interaction.reply(`🛍️ Shop\n${items || 'No items yet.'}`);
          break;
        }
        case 'buy': {
          const itemName = interaction.options.getString('item');
          const guildState = getGuildState(interaction.guild.id);
          const item = (guildState.shop || []).find((entry) => entry.name.toLowerCase() === itemName.toLowerCase());
          if (!item) return interaction.reply({ content: '⚠️ Item not found.', ephemeral: true });
          const userState = getUserState(interaction.user.id);
          if (userState.balance < item.price) return interaction.reply({ content: '⚠️ You do not have enough coins.', ephemeral: true });
          userState.balance -= item.price;
          userState.inventory.push(item.name);
          saveState();
          await interaction.reply(`🛍️ You bought **${item.name}**.`);
          break;
        }
        case 'inventory': {
          const userState = getUserState(interaction.user.id);
          await interaction.reply(`🎒 Inventory: ${userState.inventory.length ? userState.inventory.join(', ') : 'empty'}`);
          break;
        }
        case 'level': {
          const userState = getUserState(interaction.user.id);
          await interaction.reply(`📈 You are level **${userState.level}** with **${userState.xp}** XP.`);
          break;
        }
        case 'leaderboard': {
          const sorted = Object.entries(state.users).sort((a, b) => (b[1].level || 0) - (a[1].level || 0)).slice(0, 10);
          const lines = sorted.map(([id, data], index) => `${index + 1}. <@${id}> — Level ${data.level} (${data.xp} XP)`).join('\n');
          await interaction.reply(`🏆 Leaderboard\n${lines || 'No data yet.'}`);
          break;
        }
        case 'coinflip': {
          await interaction.reply(Math.random() > 0.5 ? '🪙 Heads' : '🪙 Tails');
          break;
        }
        case 'dice': {
          await interaction.reply(`🎲 You rolled a **${1 + Math.floor(Math.random() * 6)}**.`);
          break;
        }
        case 'rps': {
          const choices = ['rock', 'paper', 'scissors'];
          const botChoice = choices[Math.floor(Math.random() * choices.length)];
          const userChoice = interaction.options.getString('choice').toLowerCase();
          if (!choices.includes(userChoice)) return interaction.reply({ content: '⚠️ Choose rock, paper, or scissors.', ephemeral: true });
          const result = userChoice === botChoice ? 'Tie' : ((userChoice === 'rock' && botChoice === 'scissors') || (userChoice === 'paper' && botChoice === 'rock') || (userChoice === 'scissors' && botChoice === 'paper') ? 'You win' : 'Bot wins');
          await interaction.reply(`🪨✋✂️ Bot chose **${botChoice}** — **${result}**.`);
          break;
        }
        case '8ball': {
          const answers = ['Yes', 'No', 'Definitely', 'Ask again later', 'Probably', 'Absolutely not'];
          await interaction.reply(`🎱 ${answers[Math.floor(Math.random() * answers.length)]}`);
          break;
        }
        case 'suggest': {
          const suggestion = interaction.options.getString('suggestion');
          const guildState = getGuildState(interaction.guild.id);
          guildState.suggestions.push({ userId: interaction.user.id, text: suggestion, createdAt: new Date().toISOString() });
          saveState();
          await interaction.reply('💡 Your suggestion was recorded.');
          break;
        }
        case 'announce': {
          const messageText = interaction.options.getString('message');
          const guildState = getGuildState(interaction.guild.id);
          const channel = guildState.announcementsChannelId ? interaction.guild.channels.cache.get(guildState.announcementsChannelId) : interaction.channel;
          if (!channel?.isTextBased()) return interaction.reply({ content: '⚠️ No announcement channel configured.', ephemeral: true });
          await channel.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('📢 Announcement').setDescription(messageText)] });
          await interaction.reply('📢 Announcement sent.');
          break;
        }
        case 'kick': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const target = interaction.options.getMember('target');
          const reason = interaction.options.getString('reason') || 'No reason specified';
          if (!target?.kickable) return interaction.reply({ content: '❌ I cannot kick that user.', ephemeral: true });
          await target.kick(reason);
          await interaction.reply(`👮 ${target.user.tag} was kicked. Reason: ${reason}`);
          break;
        }
        case 'ban': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const target = interaction.options.getMember('target');
          const reason = interaction.options.getString('reason') || 'No reason specified';
          if (!target?.bannable) return interaction.reply({ content: '❌ I cannot ban that user.', ephemeral: true });
          await target.ban({ reason });
          await interaction.reply(`🔨 ${target.user.tag} was banned. Reason: ${reason}`);
          break;
        }
        case 'tempban': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const target = interaction.options.getMember('target');
          const hours = interaction.options.getInteger('hours');
          const reason = interaction.options.getString('reason') || 'No reason specified';
          if (!target?.bannable) return interaction.reply({ content: '❌ I cannot ban that user.', ephemeral: true });
          await target.ban({ reason });
          setTimeout(() => interaction.guild.members.unban(target.id).catch(() => null), hours * 60 * 60 * 1000);
          await interaction.reply(`⏳ ${target.user.tag} was banned for ${hours} hours.`);
          break;
        }
        case 'softban': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const target = interaction.options.getMember('target');
          const reason = interaction.options.getString('reason') || 'No reason specified';
          if (!target?.bannable) return interaction.reply({ content: '❌ I cannot softban that user.', ephemeral: true });
          await target.ban({ deleteMessageSeconds: 60 * 60 * 24, reason });
          await interaction.guild.members.unban(target.id).catch(() => null);
          await interaction.reply(`🧹 ${target.user.tag} was soft-banned. Reason: ${reason}`);
          break;
        }
        case 'warn': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const target = interaction.options.getMember('target');
          const reason = interaction.options.getString('reason') || 'No reason provided';
          const userState = getUserState(target.id);
          userState.warnings.push({ moderator: interaction.user.id, reason, createdAt: new Date().toISOString() });
          saveState();
          await interaction.reply(`⚠️ ${target.user.tag} was warned. Reason: ${reason}`);
          break;
        }
        case 'unwarn': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const target = interaction.options.getMember('target');
          const userState = getUserState(target.id);
          userState.warnings.pop();
          saveState();
          await interaction.reply(`🧼 Removed the latest warning for ${target.user.tag}.`);
          break;
        }
        case 'warnings': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const target = interaction.options.getMember('target');
          const userState = getUserState(target.id);
          const entries = userState.warnings.map((warning, index) => `${index + 1}. ${warning.reason}`).join('\n') || 'No warnings';
          await interaction.reply(`⚠️ Warnings for ${target.user.tag}:\n${entries}`);
          break;
        }
        case 'mute': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const target = interaction.options.getMember('target');
          const minutes = interaction.options.getInteger('minutes');
          const reason = interaction.options.getString('reason') || 'No reason provided';
          if (!target || !minutes) return interaction.reply({ content: '⚠️ Please provide a valid target and duration.', ephemeral: true });
          await target.timeout(minutes * 60 * 1000, reason);
          await interaction.reply(`⏱️ ${target.user.tag} was timed out for ${minutes} minutes.`);
          break;
        }
        case 'unmute': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const target = interaction.options.getMember('target');
          await target.timeout(null);
          await interaction.reply(`✅ ${target.user.tag} was untimed out.`);
          break;
        }
        case 'purge': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const amount = interaction.options.getInteger('amount');
          if (!amount || amount < 1 || amount > 100) return interaction.reply({ content: '⚠️ Use a value between 1 and 100.', ephemeral: true });
          await interaction.channel.bulkDelete(amount, true);
          await interaction.reply({ content: `🧹 Deleted ${amount} messages.`, ephemeral: true });
          break;
        }
        case 'slowmode': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const seconds = interaction.options.getInteger('seconds');
          await interaction.channel.setRateLimitPerUser(seconds);
          await interaction.reply(`⏱️ Slowmode set to ${seconds} seconds.`);
          break;
        }
        case 'nick': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          const target = interaction.options.getMember('target');
          const nickname = interaction.options.getString('nickname');
          await target.setNickname(nickname);
          await interaction.reply(`📝 Updated ${target.user.tag}'s nickname.`);
          break;
        }
        case 'lock': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false }).catch(() => null);
          await interaction.reply('🔒 Channel locked.');
          break;
        }
        case 'unlock': {
          if (!canModerate(interaction.member)) return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
          await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: null }).catch(() => null);
          await interaction.reply('🔓 Channel unlocked.');
          break;
        }
        case 'setup-welcome': {
          const channel = interaction.options.getChannel('channel');
          getGuildState(interaction.guild.id).welcome.channelId = channel.id;
          saveState();
          await interaction.reply(`✅ Welcome channel set to ${channel}.`);
          break;
        }
        case 'setup-leave': {
          const channel = interaction.options.getChannel('channel');
          getGuildState(interaction.guild.id).leave.channelId = channel.id;
          saveState();
          await interaction.reply(`✅ Leave channel set to ${channel}.`);
          break;
        }
        case 'set-auto-role': {
          const role = interaction.options.getRole('role');
          getGuildState(interaction.guild.id).autoRoleId = role.id;
          saveState();
          await interaction.reply(`✅ Auto-role set to ${role}.`);
          break;
        }
        case 'setup-selfrole': {
          const role = interaction.options.getRole('role');
          const label = interaction.options.getString('label') || 'Claim role';
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`selfrole:${role.id}`).setLabel(label).setStyle(ButtonStyle.Primary)
          );
          await interaction.reply({ content: 'Self-role panel deployed.', ephemeral: true });
          await interaction.channel.send({ content: `Click below to toggle **${role.name}**`, components: [row] });
          break;
        }
        case 'setup-tickets': {
          const embed = new EmbedBuilder().setColor('#FF5555').setTitle('🎫 Help & Support Tickets').setDescription('Click the button below to open a private support room.');
          const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('open_ticket').setLabel('Create Ticket').setStyle(ButtonStyle.Danger).setEmoji('📩'));
          await interaction.reply({ content: 'Ticket panel deployed.', ephemeral: true });
          await interaction.channel.send({ embeds: [embed], components: [row] });
          break;
        }
        case 'prefix': {
          const value = interaction.options.getString('value');
          getGuildState(interaction.guild.id).prefix = value;
          saveState();
          await interaction.reply(`✅ Prefix updated to **${value}**.`);
          break;
        }
        case 'setlogchannel': {
          const channel = interaction.options.getChannel('channel');
          getGuildState(interaction.guild.id).logging.channelId = channel.id;
          saveState();
          await interaction.reply(`✅ Logging channel set to ${channel}.`);
          break;
        }
        case 'poll': {
          const question = interaction.options.getString('question');
          const options = interaction.options.getString('options').split(',').map((entry) => entry.trim()).filter(Boolean);
          if (options.length < 2) return interaction.reply({ content: '⚠️ Provide at least two comma-separated options.', ephemeral: true });
          const pollMessage = await interaction.channel.send({ embeds: [new EmbedBuilder().setColor('#5865F2').setTitle('📊 Poll').setDescription(question).addFields(options.map((option, index) => ({ name: `${index + 1}. ${option}`, value: '⬜', inline: false }))) ] });
          const emojiList = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
          for (let index = 0; index < Math.min(options.length, emojiList.length); index += 1) {
            await pollMessage.react(emojiList[index]).catch(() => null);
          }
          await interaction.reply('✅ Poll created.');
          break;
        }
        case 'remind': {
          const duration = parseDuration(interaction.options.getString('time'));
          const messageText = interaction.options.getString('message');
          if (!duration || !messageText) return interaction.reply({ content: '⚠️ Use a valid time like 10m, 1h, or 2d.', ephemeral: true });
          const timeoutId = setTimeout(async () => {
            try {
              await interaction.user.send(`⏰ Reminder: ${messageText}`);
            } catch {}
            reminders.delete(timeoutId);
          }, duration);
          reminders.set(timeoutId, { userId: interaction.user.id, createdAt: Date.now() });
          await interaction.reply(`✅ Reminder set for ${interaction.options.getString('time')}.`);
          break;
        }
        case 'streamremind': {
          const platform = interaction.options.getString('platform').toLowerCase();
          const name = interaction.options.getString('name');
          const duration = parseDuration(interaction.options.getString('time'));
          if (!['youtube', 'twitch'].includes(platform) || !name || !duration) return interaction.reply({ content: '⚠️ Use youtube or twitch with a valid time.', ephemeral: true });
          const timeoutId = setTimeout(async () => {
            try {
              await interaction.user.send(`📺 Reminder: ${name} on ${platform} is starting soon.`);
            } catch {}
            reminders.delete(timeoutId);
          }, duration);
          reminders.set(timeoutId, { userId: interaction.user.id, createdAt: Date.now(), platform, name });
          await interaction.reply(`✅ Stream reminder set for ${name} on ${platform}.`);
          break;
        }
        case 'addblockword': {
          const word = interaction.options.getString('word');
          const guildState = getGuildState(interaction.guild.id);
          guildState.autoMod.blockedWords = Array.from(new Set([...(guildState.autoMod.blockedWords || []), word.toLowerCase()]));
          saveState();
          await interaction.reply(`✅ Added **${word}** to the blocked words list.`);
          break;
        }
        case 'removeblockword': {
          const word = interaction.options.getString('word');
          const guildState = getGuildState(interaction.guild.id);
          guildState.autoMod.blockedWords = (guildState.autoMod.blockedWords || []).filter((entry) => entry.toLowerCase() !== word.toLowerCase());
          saveState();
          await interaction.reply(`✅ Removed **${word}** from the blocked words list.`);
          break;
        }
        case 'setup-reactionrole': {
          const role = interaction.options.getRole('role');
          const emoji = interaction.options.getString('emoji');
          const label = interaction.options.getString('label') || role.name;
          const panelMessage = await interaction.channel.send({ content: `${label}\nReact with ${emoji} to get **${role.name}**.` });
          await panelMessage.react(emoji).catch(() => null);
          getGuildState(interaction.guild.id).reactionRoles.push({ messageId: panelMessage.id, channelId: panelMessage.channel.id, roleId: role.id, emoji: getReactionKey(emoji) });
          saveState();
          await interaction.reply('✅ Reaction-role panel created.');
          break;
        }
        case 'play': {
          const url = interaction.options.getString('url');
          if (!interaction.member.voice?.channel) return interaction.reply({ content: '⚠️ Join a voice channel first.', ephemeral: true });
          try {
            const track = await resolveTrackInfo(url);
            const state = await ensureVoiceConnection(interaction.guild.id, interaction.member.voice.channel, interaction.channel);
            state.queue.push(track);
            if (!state.player || state.player.state.status === AudioPlayerStatus.Idle) {
              await playNextTrack(interaction.guild.id);
            }
            await interaction.reply(`🎵 Added **${track.title}** to the queue.`);
          } catch (error) {
            console.error(error);
            await interaction.reply({ content: '⚠️ I could not play that track.', ephemeral: true });
          }
          break;
        }
        case 'queue': {
          const state = getMusicState(interaction.guild.id);
          if (!state.current && !state.queue.length) return interaction.reply('🎵 The queue is empty.');
          const lines = [state.current ? `Now playing: ${state.current.title}` : 'Now playing: nothing', ...state.queue.slice(0, 10).map((entry, index) => `${index + 1}. ${entry.title}`)];
          await interaction.reply(`🎵 Queue\n${lines.join('\n')}`);
          break;
        }
        case 'skip': {
          const state = getMusicState(interaction.guild.id);
          if (!state.player) return interaction.reply('🎵 Nothing is playing right now.');
          state.player.stop();
          await interaction.reply('⏭️ Skipped the current track.');
          break;
        }
        case 'pause': {
          const state = getMusicState(interaction.guild.id);
          if (!state.player) return interaction.reply('🎵 Nothing is playing right now.');
          state.player.pause();
          await interaction.reply('⏸️ Paused the music.');
          break;
        }
        case 'resume': {
          const state = getMusicState(interaction.guild.id);
          if (!state.player) return interaction.reply('🎵 Nothing is playing right now.');
          state.player.unpause();
          await interaction.reply('▶️ Resumed the music.');
          break;
        }
        case 'stop': {
          await stopMusic(interaction.guild.id);
          await interaction.reply('🛑 Stopped the music player.');
          break;
        }
        case 'setlang': {
          const language = interaction.options.getString('language');
          getGuildState(interaction.guild.id).language = language;
          saveState();
          await interaction.reply(`✅ Language updated to **${language}**.`);
          break;
        }
        case 'backup': {
          const backupPath = backupState('slash');
          await interaction.reply(`💾 Backup created at **${path.basename(backupPath)}**.`);
          break;
        }
        case 'restore': {
          const restored = restoreLatestBackup();
          await interaction.reply(restored ? '✅ Backup restored successfully.' : '⚠️ No backup found to restore.');
          break;
        }
      }
    } catch (error) {
      console.error(error);
      await interaction.reply({ content: '⚠️ An unexpected error occurred.', ephemeral: true });
    }
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith('help:')) {
      const [, category = 'all'] = interaction.customId.split(':');
      const guildState = getGuildState(interaction.guild.id);
      const embed = buildHelpEmbed(guildState.prefix, category);
      await interaction.update({ embeds: [embed], components: buildHelpComponents(category) });
      return;
    }

    if (interaction.customId === 'open_ticket') {
      const ticketCount = Object.keys(state.tickets || {}).length + 1;
      const ticketChannel = await interaction.guild.channels.create({
        name: `ticket-${ticketCount}`,
        type: 0,
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
        ]
      });

      state.tickets[ticketChannel.id] = { ownerId: interaction.user.id, createdAt: new Date().toISOString() };
      saveState();

      await interaction.reply({ content: `🎫 Your ticket room has been created: ${ticketChannel}`, ephemeral: true });
      await ticketChannel.send({ content: `Welcome ${interaction.user}! Support will join you shortly.` });
      return;
    }

    if (interaction.customId.startsWith('selfrole:')) {
      const roleId = interaction.customId.split(':')[1];
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) return interaction.reply({ content: '⚠️ That role is no longer available.', ephemeral: true });
      const hasRole = interaction.member.roles.cache.has(roleId);
      if (hasRole) {
        await interaction.member.roles.remove(role).catch(() => null);
        await interaction.reply({ content: `✅ Removed **${role.name}** from you.`, ephemeral: true });
      } else {
        await interaction.member.roles.add(role).catch(() => null);
        await interaction.reply({ content: `✅ Added **${role.name}** to you.`, ephemeral: true });
      }
    }
  }

  if (interaction.isContextMenuCommand()) {
    if (interaction.commandName === 'User Info') {
      const target = interaction.targetUser;
      const embed = new EmbedBuilder().setColor('#57F287').setTitle(`User Info: ${target.tag}`).setDescription(`ID: ${target.id}`).setThumbnail(target.displayAvatarURL());
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.commandName === 'Message Info') {
      const target = interaction.targetMessage;
      const embed = new EmbedBuilder().setColor('#5865F2').setTitle('Message Info').setDescription(target.content || 'No content');
      await interaction.reply({ embeds: [embed], ephemeral: true });
    }
  }
});

if (!configReady) {
  process.exit(1);
}

client.login(TOKEN).catch((error) => {
  console.error('❌ Failed to connect to Discord.', error);
  process.exit(1);
});