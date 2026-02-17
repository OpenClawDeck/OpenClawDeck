package main

import (
	"os"

	"openclawdeck/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args))
}
