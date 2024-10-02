package tunnel

import (
	"context"
	"log/slog"
	"os"
	"os/exec"
	"runtime"
	"time"
)

func Start(ctx context.Context, routes ...string) error {
	name := "utun69"
	slog.Info("creating interface", "name", name, "os", runtime.GOOS)
	socksCmd := exec.CommandContext(ctx, "tun2socks", "-device", name, "-proxy", "socks5://127.0.0.1:1080")
	socksCmd.Stdout = os.Stdout
	socksCmd.Stderr = os.Stderr
	socksCmd.Start()
	time.Sleep(time.Second * 1)
	cmds := [][]string{
		{"ifconfig", "utun69", "172.16.0.1", "172.16.0.1", "netmask", "255.255.0.0", "up"},
		// {"ip", "link", "set", "dev", name, "up"},
	}
	// for _, route := range routes {
	// 	cmds = append(cmds, []string{
	// 		"route", "add", "-net", route, "172.16.0.1",
	// 	})
	// }
	err := runCommands(cmds)
	if err != nil {
		return err
	}
	return socksCmd.Wait()
}