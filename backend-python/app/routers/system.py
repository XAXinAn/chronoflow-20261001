from __future__ import annotations

import os

from fastapi import APIRouter

from ..errors import envelope

router = APIRouter(prefix="/api/v1/system", tags=["system"])


@router.get("/info")
def info() -> dict:
    return envelope(
        {
            "name": os.getenv("APP_NAME", "xa-todo-backend"),
            "version": os.getenv("XATODO_VERSION", "0.1.0"),
            "serverTime": None,
        }
    )


@router.get("/ping")
def ping() -> dict:
    return envelope("pong")
