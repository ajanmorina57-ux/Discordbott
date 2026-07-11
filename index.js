import http from 'http';
import { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    PermissionFlagsBits
} from 'discord.js';

// 1. Dummy Web Server for Render & Uptime Workers
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Mega Bot is alive!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 Web server active on port ${PORT}`));

// 2. Initialize Discord Client with necessary Intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// Mock Local Databases (In-Memory for single-file demonstration)
const economyDB = new Map(); // Stores user balances
const ticketCount = { count: 0 };

// 3. Define Mega Slash Commands List
const commands = [
    // Utility
    new SlashCommandBuilder().setName('ping').setDescription('Replies with bot latency'),
    
    // Moderation
    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('👮 Kick a member')
        .addUserOption(opt => opt.setName('target').setDescription('The user to kick').setRequired(true))
        .addStringOption(opt => opt.setName('reason').setDescription('Reason for kick'))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
    
    new SlashCommandBuilder()
        .setName('purge')
        .setDescription('🧹 Mass delete messages')
        .addIntegerOption(opt => opt.setName('amount').setDescription('Number of messages').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    // Economy
    new SlashCommandBuilder().setName('balance').setDescription('💰 Check your wallet balance'),
    new SlashCommandBuilder().setName('daily').setDescription('🎁 Claim your daily free coins'),

    // Tickets
    new SlashCommandBuilder()
        .setName('setup-tickets')
        .setDescription('🎫 Deploy a support ticket panel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(cmd => cmd.toJSON());

// 4. Client Ready Event
client.once('ready', async () => {
    console.log(`🤖 Mega Bot deployed as ${client.user.tag}`);
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log('✅ All Mega-Bot commands registered successfully.');
    } catch (err) {
        console.error(err);
    }
});

// 5. 🎉 Welcome Module (Triggers when someone joins the server)
client.on('guildMemberAdd', async (member) => {
    // Looks for a channel named 'welcome'
    const welcomeChannel = member.guild.channels.cache.find(ch => ch.name.includes('welcome'));
    if (!welcomeChannel) return;

    const welcomeEmbed = new EmbedBuilder()
        .setColor('#00FFCC')
        .setTitle('🎉 Welcome to the Server!')
        .setDescription(`Hello ${member}, welcome to **${member.guild.name}**! You are member #${member.guild.memberCount}.`)
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp();

    welcomeChannel.send({ embeds: [welcomeEmbed] });
});

// 6. 🛡️ Auto-Moderation Module (Anti-Link & Anti-Spam)
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // Direct Anti-Link Filter
    if (message.content.includes('http://') || message.content.includes('https://') || message.content.includes('discord.gg/')) {
        // Skip link protection for Administrators
        if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        
        await message.delete();
        const warning = await message.channel.send(`⚠️ ${message.author}, links are not allowed here!`);
        setTimeout(() => warning.delete().catch(() => null), 5000);
    }
});

// 7. Interaction Router (Commands, Buttons, Panels)
client.on('interactionCreate', async (interaction) => {
    // Handle Slash Commands
    if (interaction.isChatInputCommand()) {
        const { commandName } = interaction;

        // PING
        if (commandName === 'ping') {
            return interaction.reply(`🏓 Pong! Latency is ${client.ws.ping}ms.`);
        }

        // KICK
        if (commandName === 'kick') {
            const target = interaction.options.getMember('target');
            const reason = interaction.options.getString('reason') || 'No reason specified';
            if (!target.kickable) return interaction.reply({ content: '❌ I cannot kick this user.', ephemeral: true });
            
            await target.kick(reason);
            return interaction.reply({ content: `👮 **${target.user.tag}** has been kicked. Reason: ${reason}` });
        }

        // PURGE
        if (commandName === 'purge') {
            const amount = interaction.options.getInteger('amount');
            if (amount < 1 || amount > 100) return interaction.reply({ content: 'Keep amount between 1-100', ephemeral: true });
            
            await interaction.channel.bulkDelete(amount, true);
            return interaction.reply({ content: `🧹 Cleared ${amount} messages.`, ephemeral: true });
        }

        // ECONOMY: BALANCE
        if (commandName === 'balance') {
            const bal = economyDB.get(interaction.user.id) || 0;
            return interaction.reply(`💰 **${interaction.user.username}**, you have **$${bal}** coins inside your vault.`);
        }

        // ECONOMY: DAILY
        if (commandName === 'daily') {
            const currentBal = economyDB.get(interaction.user.id) || 0;
            economyDB.set(interaction.user.id, currentBal + 500);
            return interaction.reply(`🎁 You claimed your daily reward of **$500** coins!`);
        }

        // TICKET SETUP PANEL
        if (commandName === 'setup-tickets') {
            const embed = new EmbedBuilder()
                .setColor('#FF5555')
                .setTitle('🎫 Help & Support Tickets')
                .setDescription('Click the button below to open a private support room with the staff team.');

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('open_ticket')
                    .setLabel('Create Ticket')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('📩')
            );

            await interaction.reply({ content: 'Ticket panel deployed.', ephemeral: true });
            return interaction.channel.send({ embeds: [embed], components: [row] });
        }
    }

    // Handle Button Interactions (For Tickets Module)
    if (interaction.isButton()) {
        if (interaction.customId === 'open_ticket') {
            ticketCount.count++;
            
            // Create a completely brand new private channel for the user
            const ticketChannel = await interaction.guild.channels.create({
                name: `ticket-${ticketCount.count}`,
                type: 0, // Text Channel
                permissionOverwrites: [
                    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
                ]
            });

            await interaction.reply({ content: `🎫 Your ticket room has been created: ${ticketChannel}`, ephemeral: true });
            
            const welcomeEmbed = new EmbedBuilder()
                .setColor('#55FF55')
                .setTitle(`Ticket #${ticketCount.count}`)
                .setDescription(`Welcome ${interaction.user}. State your inquiry clearly. Support staff will arrive shortly.`);

            return ticketChannel.send({ embeds: [welcomeEmbed] });
        }
    }
});

client.login(TOKEN);