"""ccx のアーキテクチャ図を生成する。

    python3 docs/design/diagrams/architecture.py

生成物 (architecture.png) は同じディレクトリに置き、リポジトリに commit する。
"""

from diagrams import Cluster, Diagram, Edge
from diagrams.generic.blank import Blank
from diagrams.generic.storage import Storage
from diagrams.onprem.client import User
from diagrams.onprem.compute import Server
from diagrams.onprem.queue import Rabbitmq
from diagrams.programming.flowchart import Database

GRAPH_ATTR = {
    "fontsize": "18",
    "bgcolor": "transparent",
    "pad": "0.5",
    "nodesep": "0.9",
    "ranksep": "1.3",
}

with Diagram(
    "ccx — parallel AI coding sessions",
    filename="docs/design/diagrams/architecture",
    show=False,
    direction="LR",
    graph_attr=GRAPH_ATTR,
):
    human = User("human")

    with Cluster("central (optional — omit it and the CLI still works)"):
        broker = Rabbitmq("broker\npluggable")
        hub = Server("hub\nAPI + web UI")
        registry = Database("registry\nsessions + repodirs")

        broker >> hub >> registry

    with Cluster("machine (one of many)"):
        cli = Server("ccx\none-shot CLI")
        ccxd = Server("ccxd\nresident agent")

        with Cluster("herdr — session substrate"):
            session = Blank("claude session\n(one per repodir)")

        with Cluster("~/.ccx"):
            mirror = Storage(".mirror\nbare, never checked out")
            repodir = Storage("<host>/<owner>/<repo>/<dir-id>\nrepodir")

    # ---- what the human does ----
    human >> Edge(label="rd new / open / gc") >> cli
    human >> Edge(label="watch every machine,\nread the conversation", style="dotted") >> hub

    # ---- how a repodir comes into being ----
    mirror >> Edge(label="hardlink clone — 0.07s", style="bold") >> repodir
    cli >> Edge(label="creates") >> repodir
    cli >> Edge(label="opens") >> session

    # ---- the inbound path: broker to a running session, no keystrokes ----
    broker >> Edge(label="1. pull", color="firebrick", fontcolor="firebrick") >> ccxd
    ccxd >> Edge(
        label="2. push — MCP channel\nwakes an idle session",
        color="firebrick",
        fontcolor="firebrick",
        style="bold",
    ) >> session

    # ---- what ccxd watches, and what it sends back ----
    repodir >> Edge(label="observes — never writes", style="dashed") >> ccxd
    session >> Edge(label="replies", color="darkgreen", fontcolor="darkgreen", style="dashed") >> ccxd
    ccxd >> Edge(label="reports state + replies", color="darkgreen", fontcolor="darkgreen") >> broker
