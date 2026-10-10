package main

import (
	"fmt"
	"net/http/httptest"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func main() {
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.GET("/", func(c *gin.Context) { c.JSON(200, gin.H{"version": version}) })
	router.GET("/metrics", gin.WrapH(promhttp.Handler()))
	if len(os.Args) > 1 && os.Args[1] == "--self-test" {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest("GET", "/", nil))
		if response.Code != 200 { panic("unexpected status") }
		fmt.Println(response.Body.String())
		return
	}
	if err := router.Run(":8080"); err != nil { panic(err) }
}
