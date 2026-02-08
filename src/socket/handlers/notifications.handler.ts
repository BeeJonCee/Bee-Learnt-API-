import type { Server, Socket } from "socket.io";
import { logInfo } from "../../shared/utils/logger.js";

export interface NotificationPayload {
  id: number;
  type: string;
  title: string;
  message?: string;
  createdAt: string;
  data?: Record<string, unknown>;
}

export interface BadgeAwardedPayload {
  badgeId: number;
  badgeName: string;
  description?: string;
  awardedAt: string;
}

export interface LeaderboardUpdatePayload {
  userId: string;
  newRank: number;
  previousRank: number;
  score: number;
}

export function registerNotificationHandlers(io: Server, socket: Socket): void {
  const user = socket.data.user;

  // Mark notification as read
  socket.on("notification:read", async (notificationId: number) => {
    if (!user?.id) {
      socket.emit("error", { message: "Unauthorized" });
      return;
    }

    logInfo(`User ${user.id} marked notification ${notificationId} as read`);

    // Emit acknowledgment
    socket.emit("notification:read:ack", { notificationId, readAt: new Date().toISOString() });
  });

  // Subscribe to specific notification types
  socket.on("notification:subscribe", (types: string[]) => {
    if (!user?.id) return;

    for (const type of types) {
      socket.join(`notification:${type}`);
    }
    logInfo(`User ${user.id} subscribed to notification types: ${types.join(", ")}`);
  });

  // Unsubscribe from notification types
  socket.on("notification:unsubscribe", (types: string[]) => {
    if (!user?.id) return;

    for (const type of types) {
      socket.leave(`notification:${type}`);
    }
  });
}

// Server-side emit functions (to be called from services)
export function emitNotification(io: Server, userId: string, notification: NotificationPayload): void {
  io.to(`user:${userId}`).emit("notification:new", notification);
  logInfo(`Emitted notification to user ${userId}: ${notification.title}`);
}

export function emitBadgeAwarded(io: Server, userId: string, badge: BadgeAwardedPayload): void {
  io.to(`user:${userId}`).emit("badge:awarded", badge);
  logInfo(`Emitted badge award to user ${userId}: ${badge.badgeName}`);
}

export function emitLeaderboardUpdate(io: Server, userId: string, update: LeaderboardUpdatePayload): void {
  io.to(`user:${userId}`).emit("leaderboard:update", update);
}

export function emitAnnouncementToRole(io: Server, role: string, announcement: {
  id: number;
  title: string;
  body: string;
  publishedAt: string;
}): void {
  io.to(`role:${role}`).emit("announcement:new", announcement);
  logInfo(`Emitted announcement to role ${role}: ${announcement.title}`);
}

export function emitAnnouncementToAll(io: Server, announcement: {
  id: number;
  title: string;
  body: string;
  publishedAt: string;
}): void {
  io.emit("announcement:new", announcement);
  logInfo(`Emitted announcement to all: ${announcement.title}`);
}
