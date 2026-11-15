package com.minecraftjs.voicebridge;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import org.bukkit.entity.Player;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.plugin.messaging.PluginMessageListener;

import com.google.common.io.ByteArrayDataInput;
import com.google.common.io.ByteStreams;

/**
 * McjsVoiceBridge: lets MinecraftJS 1.13.2 browser clients (and any vanilla
 * client speaking Eagler's V1 voice RPC) use proximity voice chat on a
 * Bukkit/Spigot/Paper backend.
 *
 * <p>Why this exists: stock Eagler backends only run voice for
 * Eagler-protocol connections (tracked by the proxy). A vanilla 1.13.2
 * client that announces voice capability on the plugin channel
 * {@code "eagler:1-8-voice-rpc"} is ignored — there is nothing listening.
 * This plugin listens on exactly that channel and runs a small V1 voice
 * hub: players that send INIT get a Capable reply, join the channel on
 * Connect, and get paired peer-to-peer (WebRTC/Opus, same as Eagler) via
 * forwarded SDP/ICE. Audio never touches the server.
 *
 * <p>Packet layout mirrors EaglerVCProtocol.V1 (big-endian, Java
 * DataOutput order). Only the framing used by the MinecraftJS client is
 * implemented: INIT Capable, Connect, ConnectPeer, Description,
 * ICECandidate, Disconnect, DisconnectPeer (client side) and Capable,
 * Allowed, PlayerList, Announce, ConnectPeer, DisconnectPeer, Description,
 * ICECandidate (server side).
 *
 * <p>Interop notes (read before expecting Eagler players in the same call):
 * <ul>
 *   <li>Gameplay already works: Eagler players and vanilla/MinecraftJS
 *       players share the same backend world (via ViaVersion or a common
 *       version) and see each other.</li>
 *   <li>Voice with Eagler web clients needs no server change at all if
 *       each Eagler player opens the generator's {@code ?voicebridge}
 *       companion tab (matched by name for proximity). That path works
 *       today, on any server, and is the recommended mixed-play setup.</li>
 *   <li>This hub does NOT inject vanilla players into Eagler's own voice
 *       channels: Eagler web clients receive voice over the EAG/backend
 *       RPC path, not over player plugin messages. Merging the two at the
 *       backend requires the Eagler API (IVoiceService / VoiceChannel);
 *       see README.md for the exact touchpoints for a follow-up.</li>
 * </ul>
 */
public class McjsVoiceBridge extends JavaPlugin implements PluginMessageListener {

    /** Modern (1.13+) voice RPC channel. Legacy "EAG|1.8-Voice-RPC" is not
     * valid on 1.13+ connections, so only this name is used. */
    public static final String CHANNEL = "eagler:1-8-voice-rpc";

    // Server -> client V1 ids
    private static final int S_ALLOWED = 1;
    private static final int S_PLAYER_LIST = 2;
    private static final int S_ANNOUNCE = 3;
    private static final int S_CONNECT_PEER = 4;
    private static final int S_DISCONNECT_PEER = 5;
    private static final int S_DESCRIPTION = 6;
    private static final int S_ICE = 7;

    // Client -> server V1 ids
    private static final int C_CONNECT = 1;
    private static final int C_CONNECT_PEER = 2;
    private static final int C_DISCONNECT = 3;
    private static final int C_DISCONNECT_PEER = 4;
    private static final int C_DESCRIPTION = 5;
    private static final int C_ICE = 6;

    private final Map<UUID, Session> sessions = new HashMap<>();
    private final Map<String, Pair> pairs = new HashMap<>();
    private List<String> iceServers = new ArrayList<>();
    private boolean allowed;
    private boolean overrideIce;

    private static class Session {
        final UUID uuid;
        String name;
        long lastConnectPeer;
        int connectPeerTokens = 20;
        Session(UUID uuid, String name) { this.uuid = uuid; this.name = name; }
    }

    private static class Pair {
        final UUID a, b;
        Pair(UUID a, UUID b) { this.a = a; this.b = b; }
        boolean has(UUID u) { return a.equals(u) || b.equals(u); }
        UUID other(UUID u) { return a.equals(u) ? b : a; }
    }

    @Override
    public void onEnable() {
        saveDefaultConfig();
        allowed = getConfig().getBoolean("allowed", true);
        overrideIce = getConfig().getBoolean("override-ice", true);
        iceServers = new ArrayList<>(getConfig().getStringList("ice-servers"));
        if (iceServers.isEmpty()) {
            iceServers.add("stun:stun.l.google.com:19302");
        }
        getServer().getMessenger().registerIncomingPluginChannel(this, CHANNEL, this);
        getServer().getMessenger().registerOutgoingPluginChannel(this, CHANNEL);
        getServer().getPluginManager().registerEvents(new LeaveListener(), this);
        getLogger().info("McjsVoiceBridge on '" + CHANNEL + "' (allowed=" + allowed + ")");
    }

    @Override
    public void onDisable() {
        getServer().getMessenger().unregisterIncomingPluginChannel(this, CHANNEL, this);
        getServer().getMessenger().unregisterOutgoingPluginChannel(this, CHANNEL);
    }

    // ---------- incoming ----------

    @Override
    public void onPluginMessageReceived(String channel, Player player, byte[] bytes) {
        if (!CHANNEL.equals(channel) || bytes == null || bytes.length == 0) return;
        try {
            ByteArrayDataInput in = ByteStreams.newDataInput(bytes);
            int id = in.readUnsignedByte();
            if (id == 0) { // INIT Capable
                int count = in.readUnsignedByte();
                boolean supportsV1 = false;
                for (int i = 0; i < count; i++) {
                    if (in.readUnsignedByte() == 1) supportsV1 = true;
                }
                handleInit(player, supportsV1);
                return;
            }
            Session s = sessions.get(player.getUniqueId());
            if (s == null) return; // must INIT first
            switch (id) {
                case C_CONNECT: handleConnect(player, s); break;
                case C_CONNECT_PEER: {
                    UUID target = new UUID(in.readLong(), in.readLong());
                    handleConnectPeer(player, s, target);
                    break;
                }
                case C_DISCONNECT: handleDisconnect(player, s); break;
                case C_DISCONNECT_PEER: {
                    UUID target = new UUID(in.readLong(), in.readLong());
                    handleDisconnectPeer(player, target);
                    break;
                }
                case C_DESCRIPTION: {
                    UUID target = new UUID(in.readLong(), in.readLong());
                    byte[] blob = readBlob(in);
                    if (blob != null) forwardBlob(S_DESCRIPTION, player, target, blob);
                    break;
                }
                case C_ICE: {
                    UUID target = new UUID(in.readLong(), in.readLong());
                    byte[] blob = readBlob(in);
                    if (blob != null) forwardBlob(S_ICE, player, target, blob);
                    break;
                }
                default: break;
            }
        } catch (Exception e) {
            getLogger().warning("bad voice packet from " + player.getName() + ": " + e);
        }
    }

    private void handleInit(Player player, boolean supportsV1) {
        if (!supportsV1) return;
        sessions.put(player.getUniqueId(), new Session(player.getUniqueId(), cleanName(player.getName())));
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            DataOutputStream out = new DataOutputStream(bos);
            out.writeByte(1); // INIT Capable reply
            out.writeByte(1); // version 1
            int flags = 0;
            if (allowed) flags |= 128;
            if (overrideIce) flags |= 64;
            List<String> ice = iceServers.subList(0, Math.min(63, iceServers.size()));
            flags |= ice.size();
            out.writeByte(flags);
            for (String s : ice) writeStr16(out, s);
            out.flush();
            player.sendPluginMessage(this, CHANNEL, bos.toByteArray());
        } catch (IOException e) {
            getLogger().warning("failed Capable reply: " + e);
        }
    }

    private void handleConnect(Player player, Session s) {
        try {
            sendAllowed(player, allowed);
            if (!allowed) {
                sessions.remove(player.getUniqueId());
                return;
            }
            sendPlayerList(player);
            broadcastAnnounce(player.getUniqueId());
        } catch (IOException e) {
            getLogger().warning("failed connect flow: " + e);
        }
    }

    private void handleConnectPeer(Player player, Session s, UUID target) {
        long now = System.currentTimeMillis();
        // cheap token bucket: max ~20 requests, refills 1/sec
        long dt = now - s.lastConnectPeer;
        s.connectPeerTokens = Math.min(20, s.connectPeerTokens + (int) (dt / 1000));
        s.lastConnectPeer = now;
        if (s.connectPeerTokens <= 0) return;
        s.connectPeerTokens--;
        Player other = getServer().getPlayer(target);
        if (other == null || !sessions.containsKey(target) || target.equals(player.getUniqueId())) return;
        // Pair immediately (single request pairs, unlike Eagler's mutual
        // request — simpler and harmless for hub members).
        String key = pairKey(player.getUniqueId(), target);
        if (!pairs.containsKey(key)) {
            pairs.put(key, new Pair(player.getUniqueId(), target));
            try {
                sendConnectPeer(other, player.getUniqueId(), false); // target waits
                sendConnectPeer(player, target, true); // requester offers
            } catch (IOException e) {
                getLogger().warning("failed pair: " + e);
            }
        }
    }

    private void handleDisconnect(Player player, Session s) {
        dropPlayer(player.getUniqueId());
    }

    private void handleDisconnectPeer(Player player, UUID target) {
        String key = pairKey(player.getUniqueId(), target);
        Pair p = pairs.remove(key);
        if (p != null) {
            Player other = getServer().getPlayer(target);
            if (other != null) {
                try { sendUuidPair(other, S_DISCONNECT_PEER, player.getUniqueId()); }
                catch (IOException ignored) {}
            }
        }
    }

    void handleQuit(UUID uuid) {
        dropPlayer(uuid);
    }

    private void dropPlayer(UUID uuid) {
        sessions.remove(uuid);
        List<String> dead = new ArrayList<>();
        for (Map.Entry<String, Pair> e : pairs.entrySet()) {
            if (e.getValue().has(uuid)) {
                dead.add(e.getKey());
                Player other = getServer().getPlayer(e.getValue().other(uuid));
                if (other != null) {
                    try { sendUuidPair(other, S_DISCONNECT_PEER, uuid); }
                    catch (IOException ignored) {}
                }
            }
        }
        for (String k : dead) pairs.remove(k);
    }

    private void forwardBlob(int serverId, Player from, UUID target, byte[] blob) {
        Player other = getServer().getPlayer(target);
        if (other == null) return;
        String key = pairKey(from.getUniqueId(), target);
        if (!pairs.containsKey(key)) return; // only paired peers exchange SDP/ICE
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            DataOutputStream out = new DataOutputStream(bos);
            out.writeByte(serverId);
            out.writeLong(from.getUniqueId().getMostSignificantBits());
            out.writeLong(from.getUniqueId().getLeastSignificantBits());
            if (blob.length > 32750) return;
            out.writeShort(blob.length);
            out.write(blob);
            out.flush();
            other.sendPluginMessage(this, CHANNEL, bos.toByteArray());
        } catch (IOException ignored) {}
    }

    // ---------- outgoing ----------

    private void sendAllowed(Player player, boolean ok) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bos);
        out.writeByte(S_ALLOWED);
        out.writeBoolean(ok);
        out.flush();
        player.sendPluginMessage(this, CHANNEL, bos.toByteArray());
    }

    private void sendPlayerList(Player player) throws IOException {
        List<Session> members = new ArrayList<>(sessions.values());
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bos);
        out.writeByte(S_PLAYER_LIST);
        out.writeInt(members.size());
        for (Session m : members) {
            out.writeLong(m.uuid.getMostSignificantBits());
            out.writeLong(m.uuid.getLeastSignificantBits());
        }
        for (Session m : members) writeStr8(out, m.name);
        out.flush();
        player.sendPluginMessage(this, CHANNEL, bos.toByteArray());
    }

    private void broadcastAnnounce(UUID newcomer) throws IOException {
        for (Session m : sessions.values()) {
            if (m.uuid.equals(newcomer)) continue;
            Player p = getServer().getPlayer(m.uuid);
            if (p != null) sendUuidPair(p, S_ANNOUNCE, newcomer);
        }
    }

    private void sendConnectPeer(Player player, UUID peer, boolean offer) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bos);
        out.writeByte(S_CONNECT_PEER);
        out.writeLong(peer.getMostSignificantBits());
        out.writeLong(peer.getLeastSignificantBits());
        out.writeBoolean(offer);
        out.flush();
        player.sendPluginMessage(this, CHANNEL, bos.toByteArray());
    }

    private void sendUuidPair(Player player, int id, UUID uuid) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        DataOutputStream out = new DataOutputStream(bos);
        out.writeByte(id);
        out.writeLong(uuid.getMostSignificantBits());
        out.writeLong(uuid.getLeastSignificantBits());
        out.flush();
        player.sendPluginMessage(this, CHANNEL, bos.toByteArray());
    }

    // ---------- helpers ----------

    private static byte[] readBlob(ByteArrayDataInput in) {
        try {
            int len = in.readUnsignedShort();
            if (len > 32750) return null;
            byte[] b = new byte[len];
            in.readFully(b);
            return b;
        } catch (Exception e) {
            return null;
        }
    }

    private static void writeStr16(DataOutputStream out, String s) throws IOException {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        if (b.length > 1024) throw new IOException("string too long");
        out.writeShort(b.length);
        out.write(b);
    }

    private static void writeStr8(DataOutputStream out, String s) throws IOException {
        byte[] b = s.getBytes(StandardCharsets.US_ASCII);
        if (b.length > 16) throw new IOException("name too long");
        out.writeByte(b.length);
        out.write(b);
    }

    private static String cleanName(String n) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < n.length() && sb.length() < 16; i++) {
            char c = n.charAt(i);
            if (c < 128 && c > 32) sb.append(c);
        }
        return sb.length() == 0 ? "Player" : sb.toString();
    }

    private static String pairKey(UUID a, UUID b) {
        return a.compareTo(b) < 0 ? a + "|" + b : b + "|" + a;
    }

    private class LeaveListener implements org.bukkit.event.Listener {
        @org.bukkit.event.EventHandler
        public void onQuit(org.bukkit.event.player.PlayerQuitEvent e) {
            handleQuit(e.getPlayer().getUniqueId());
        }

        @org.bukkit.event.EventHandler
        public void onKick(org.bukkit.event.player.PlayerKickEvent e) {
            handleQuit(e.getPlayer().getUniqueId());
        }
    }

    /** For tests: current hub members. */
    public Collection<UUID> members() {
        return Collections.unmodifiableSet(new HashSet<>(sessions.keySet()));
    }
}
