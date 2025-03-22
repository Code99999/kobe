import { useState, useEffect, useCallback, useRef } from "react";
import { ChatMessage } from "@/pages/Home";

// Create a singleton WebSocket instance to be shared across renders
let globalSocket: WebSocket | null = null;
const connectedClients = new Set<(status: boolean) => void>();
const messageListeners = new Map<string, (message: ChatMessage) => void>();
// Store nicknames for each user
const userNicknames = new Map<string, string>();

// Global message cache to prevent duplicates
const processedMessages = new Set<string>();
const MESSAGE_CACHE_SIZE = 100;

// Ping interval to keep connection alive
let pingInterval: number | null = null;
// Track when we last received a pong response
let lastPongTime = Date.now();
// Heartbeat interval to check if connection is alive
let heartbeatInterval: number | null = null;

// Create the WebSocket connection only once
function getSocket(): WebSocket | null {
  if (
    globalSocket &&
    (globalSocket.readyState === WebSocket.OPEN ||
      globalSocket.readyState === WebSocket.CONNECTING)
  ) {
    return globalSocket;
  }

  if (globalSocket) {
    try {
      // Clear ping interval if it exists
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }

      globalSocket.close();
    } catch (e) {
      console.log("Error closing existing socket", e);
    }
  }

  // Set up WebSocket URL
  console.log("Setting up WebSocket connection");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  console.log("WebSocket URL:", wsUrl);

  try {
    // Create a new WebSocket connection
    globalSocket = new WebSocket(wsUrl);
    console.log("WebSocket created, connecting...");

    globalSocket.onopen = () => {
      console.log("WebSocket connected successfully!");
      connectedClients.forEach((callback) => callback(true));
      lastPongTime = Date.now(); // Reset pong time

      // Set up a ping interval to keep the connection alive
      if (pingInterval) {
        clearInterval(pingInterval);
      }

      // Clear heartbeat interval if it exists
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }

      // Set up ping interval
      pingInterval = window.setInterval(() => {
        if (globalSocket && globalSocket.readyState === WebSocket.OPEN) {
          try {
            // Send a ping message to keep the connection alive
            globalSocket.send(JSON.stringify({ type: "ping" }));
            console.log("Sent ping to keep connection alive");
          } catch (e) {
            console.error("Error sending ping:", e);
          }
        }
      }, 30000); // Send ping every 30 seconds

      // Set up heartbeat interval to check for connection health
      heartbeatInterval = window.setInterval(() => {
        const now = Date.now();
        // If we haven't received a response in over 70 seconds, reconnect
        if (now - lastPongTime > 70000) {
          console.log(
            "Connection appears to be dead (no pong response). Reconnecting...",
          );

          // Close existing socket
          if (globalSocket) {
            try {
              globalSocket.close();
            } catch (e) {
              console.error("Error closing socket during heartbeat check:", e);
            }
          }

          // Clear intervals
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }

          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
          }

          // Force reconnect
          connectedClients.forEach((callback) => callback(false));
          getSocket();
        }
      }, 35000); // Check connection health every 35 seconds
    };

    globalSocket.onclose = (event) => {
      console.log(
        `WebSocket closed with code ${event.code}, reason: ${event.reason}`,
      );
      connectedClients.forEach((callback) => callback(false));

      // Clear ping interval
      if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
      }

      // Clear heartbeat interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }

      // Try to reconnect after a short delay
      setTimeout(() => {
        console.log("Attempting to reconnect WebSocket...");
        getSocket();
      }, 3000);
    };

    globalSocket.onerror = (error) => {
      console.error("WebSocket error:", error);
      connectedClients.forEach((callback) => callback(false));
    };

    globalSocket.onmessage = (event) => {
      try {
        console.log("Received WebSocket message:", event.data);
        const data = JSON.parse(event.data);

        // Handle system messages
        if (data.type === "system") {
          console.log("System message:", data.text);
          // Update last pong time for any server message (they all indicate the connection is alive)
          lastPongTime = Date.now();
          // System messages don't need to be displayed in the chat (optional)
        } else if (data.type === "pong") {
          console.log("Received pong response from server");
          // Update last pong time to indicate the connection is alive
          lastPongTime = Date.now();
        } else if (data.type === "message" && data.username) {
          // Update last pong time for any message (they all indicate the connection is alive)
          lastPongTime = Date.now();

          // Create a more reliable ID based on content alone (not time-dependent)
          const baseMessageId = `${data.username}:${data.text || ""}`;

          // Only handle if we haven't seen this exact message before
          if (!processedMessages.has(baseMessageId)) {
            // Add to processed messages cache
            processedMessages.add(baseMessageId);

            // Limit cache size to prevent memory leaks
            if (processedMessages.size > MESSAGE_CACHE_SIZE) {
              const firstItem = processedMessages.values().next().value;
              if (firstItem) {
                processedMessages.delete(firstItem);
              }
            }

            console.log("Broadcasting message to clients:", {
              baseMessageId,
              listeners: messageListeners.size,
            });

            // Determine the display name (use nickname if available)
            const displayName = data.nickname || data.username || "System";

            // Broadcast to all registered listeners
            messageListeners.forEach((callback, clientId) => {
              callback({
                username: data.username || "System",
                text: data.text || "",
                isSelf: data.username === clientId,
                nickname: data.nickname, // Include the nickname in the message
              });
            });

            // Store nickname if present
            if (data.nickname && data.username) {
              userNicknames.set(data.username, data.nickname);
            }
          } else {
            console.log("Skipping duplicate message:", baseMessageId);
          }
        }
      } catch (error) {
        console.error("Error parsing WebSocket message:", error);
      }
    };

    return globalSocket;
  } catch (error) {
    console.error("Failed to create WebSocket connection:", error);
    return null;
  }
}

// Custom hook to use the singleton WebSocket
const useWebSocket = (username: string) => {
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const hasJoined = useRef(false);
  const isSubmittingRef = useRef(false);

  // Register this component as a client
  useEffect(() => {
    // Make sure we have a socket
    const socket = getSocket();

    // Register status listener
    connectedClients.add(setConnected);

    // Register this client to receive messages
    messageListeners.set(username, (message: ChatMessage) => {
      setMessages((prev) => [...prev, message]);
    });

    // Set initial connection status
    if (socket && socket.readyState === WebSocket.OPEN) {
      setConnected(true);
    }

    // Send join message if connected
    if (socket && socket.readyState === WebSocket.OPEN && !hasJoined.current) {
      socket.send(
        JSON.stringify({
          type: "join",
          username,
        }),
      );
      hasJoined.current = true;
    }

    // Cleanup on unmount
    return () => {
      connectedClients.delete(setConnected);
      messageListeners.delete(username);
    };
  }, [username]);

  // Monitor for connection and send join message when connected
  useEffect(() => {
    if (connected && !hasJoined.current) {
      const socket = getSocket();
      if (socket) {
        socket.send(
          JSON.stringify({
            type: "join",
            username,
          }),
        );
        hasJoined.current = true;
      }
    }
  }, [connected, username]);

  // Send a message to the WebSocket server
  const sendMessage = useCallback(
    (text: string) => {
      // Prevent multiple rapid submissions
      if (isSubmittingRef.current) {
        return;
      }

      const socket = getSocket();
      if (socket && socket.readyState === WebSocket.OPEN) {
        isSubmittingRef.current = true;

        // Get current nickname if it exists
        const currentNickname = userNicknames.get(username);

        socket.send(
          JSON.stringify({
            type: "message",
            username,
            text,
            nickname: currentNickname, // Include nickname if we have one
          }),
        );

        // Reset the submission lock after a short delay
        setTimeout(() => {
          isSubmittingRef.current = false;
        }, 500);
      }
    },
    [username],
  );

  // Function to set nickname
  const setNickname = useCallback(
    (nickname: string) => {
      // Validate nickname
      if (!nickname || nickname.trim() === "") {
        return false;
      }

      const socket = getSocket();
      if (socket && socket.readyState === WebSocket.OPEN) {
        // Store nickname locally first
        userNicknames.set(username, nickname);

        // Send set_nickname command to server
        socket.send(
          JSON.stringify({
            type: "set_nickname",
            username,
            nickname,
          }),
        );

        return true;
      }

      return false;
    },
    [username],
  );

  // Get current nickname for this user
  const currentNickname = userNicknames.get(username) || null;

  return {
    connected,
    messages,
    sendMessage,
    setNickname,
    nickname: currentNickname,
  };
};

export default useWebSocket;
