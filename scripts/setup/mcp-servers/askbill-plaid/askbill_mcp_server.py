#!/usr/bin/env python3
"""
Streamlined AskBill MCP Server for Cursor Integration.

This module implements a simple MCP server that provides access to Plaid's AskBill
documentation service through the Model Context Protocol.
"""

import asyncio
import json
import uuid
import sys
from typing import Dict, List, Optional, Any

# Third-party imports
import websockets
from websockets.exceptions import ConnectionClosed

# MCP imports
from mcp.server import Server
from mcp.types import Tool, TextContent
import mcp.server.stdio

# Response type constants
TYPE_STATUS = "status"
TYPE_SOURCES = "sources"
TYPE_ANSWER = "answer"
STATUS_FINISHED = "finished"

class AskBillClient:
    """Client for interacting with the AskBill websocket service."""
    
    def __init__(self, uri: str = "wss://hello-finn.herokuapp.com/"):
        """
        Initialize the AskBill client.
        
        Args:
            uri: Websocket URI for the service
        """
        self.uri = uri
        self.connection_options = {
            "origin": "https://plaid.com"
        }
        # Generate UUIDs once at initialization
        self.anonymous_id = str(uuid.uuid4())
        self.user_id = str(uuid.uuid4())
        
    async def ask_question(self, question: str, timeout: float = 60.0) -> Dict[str, Any]:
        """
        Send a question to the websocket service and return the complete response.

        Args:
            question: The question to ask
            timeout: Maximum time to wait for a response (seconds)

        Returns:
            Dictionary containing the answer and sources
        """
        full_answer: List[str] = []
        sources: List[Dict[str, Any]] = []
        
        try:
            # Add timeout to connection
            async with websockets.connect(
                self.uri, 
                **self.connection_options,
                ping_interval=30,
                ping_timeout=15,
                close_timeout=10
            ) as websocket:
                # Prepare the question message
                question_id = uuid.uuid4().hex[:12]
                question_message = {
                    "type": "question",
                    "anonymous_id": self.anonymous_id,
                    "user_id": self.user_id,
                    "question": question,
                    "question_id": question_id,
                    "chat_history": []
                }

                # Send the question
                await websocket.send(json.dumps(question_message))

                # Listen for responses with timeout (Python 3.8+ compatible)
                async def receive_responses():
                    while True:
                        response = await websocket.recv()
                        parsed_response = json.loads(response)
                        response_type = parsed_response.get("type")

                        if response_type == TYPE_STATUS and parsed_response.get("status") == STATUS_FINISHED:
                            return
                        elif response_type == TYPE_SOURCES:
                            sources.extend(parsed_response.get("sources", []))
                        elif response_type == TYPE_ANSWER:
                            answer_part = parsed_response.get("ans", "")
                            if answer_part.strip():
                                full_answer.append(answer_part)
                
                try:
                    await asyncio.wait_for(receive_responses(), timeout=timeout)
                    return {
                        "answer": "".join(full_answer),
                        "sources": sources
                    }
                except asyncio.TimeoutError:
                    return {
                        "answer": "".join(full_answer) or f"Response timed out after {timeout} seconds.",
                        "sources": sources
                    }
        except Exception as e:
            raise e

# Initialize the MCP server
server = Server("askbill-plaid-server")

# Initialize the AskBill client
askbill_client = AskBillClient()

@server.list_tools()
async def handle_list_tools() -> List[Tool]:
    """List available tools."""
    return [
        Tool(
            name="plaid_docs",
            description="Answer any questions about Plaid's API or products. Provides guides, resources, and references to build with Plaid. Use this tool for any Plaid-related questions.",
            inputSchema={
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question to ask about Plaid's API, products, or documentation"
                    }
                },
                "required": ["question"]
            }
        ),
        Tool(
            name="ask_bill",
            description="Ask AskBill (Plaid's AI assistant) any question about Plaid services, APIs, documentation, or financial technology.",
            inputSchema={
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question to ask AskBill"
                    }
                },
                "required": ["question"]
            }
        )
    ]

@server.call_tool()
async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> List[TextContent]:
    """Handle tool calls."""
    if name in ["plaid_docs", "ask_bill"]:
        question = arguments.get("question", "")
        
        if not question:
            return [TextContent(type="text", text="Please provide a question to ask AskBill.")]
        
        try:
            response = await askbill_client.ask_question(question, 60.0)
            
            # Format the response
            answer = response.get('answer', '')
            sources = response.get('sources', [])
            
            # Create a nicely formatted response
            result = f"**AskBill Response:**\n\n{answer}"
            
            if sources:
                result += f"\n\n**Sources ({len(sources)}):**\n"
                for i, source in enumerate(sources, 1):
                    title = source.get('title', 'Unknown')
                    url = source.get('url', '')
                    if url:
                        result += f"{i}. [{title}]({url})\n"
                    else:
                        result += f"{i}. {title}\n"
            
            return [TextContent(type="text", text=result)]
            
        except Exception as e:
            error_msg = f"Error connecting to AskBill service: {str(e)}"
            return [TextContent(type="text", text=error_msg)]
    
    return [TextContent(type="text", text=f"Unknown tool: {name}")]

async def main():
    """Run the MCP server."""
    print("Starting AskBill MCP Server for Cursor...", file=sys.stderr)
    print(f"Using Python: {sys.executable}", file=sys.stderr)
    print(f"Python path: {sys.path}", file=sys.stderr)
    print("Server ready to handle Plaid documentation queries...", file=sys.stderr)
    
    # Run the server using stdio transport
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        print("Server running and ready for Cursor integration...", file=sys.stderr)
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )

if __name__ == "__main__":
    asyncio.run(main())
