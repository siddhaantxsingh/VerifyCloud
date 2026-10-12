// AXI4-Lite protocol checker: concurrent SystemVerilog assertions for the
// handshake rules of the AMBA AXI4-Lite specification, plus cover properties
// used as functional coverage. Bound to the DUT ports in tb_top.
`timescale 1ns/1ps
module axil_checker #(
  parameter int ADDR_W = 8
) (
  input logic              aclk,
  input logic              aresetn,
  input logic [ADDR_W-1:0] awaddr,
  input logic              awvalid,
  input logic              awready,
  input logic [31:0]       wdata,
  input logic [3:0]        wstrb,
  input logic              wvalid,
  input logic              wready,
  input logic [1:0]        bresp,
  input logic              bvalid,
  input logic              bready,
  input logic [ADDR_W-1:0] araddr,
  input logic              arvalid,
  input logic              arready,
  input logic [31:0]       rdata,
  input logic [1:0]        rresp,
  input logic              rvalid,
  input logic              rready
);
  // ---- master-side stability (checks the testbench driver) ----
  awaddr_stable: assert property (@(posedge aclk) disable iff (!aresetn)
    (awvalid && !awready) |=> (awvalid && $stable(awaddr)))
    else $error("AWADDR/AWVALID changed while AWVALID was waiting for AWREADY");

  wdata_stable: assert property (@(posedge aclk) disable iff (!aresetn)
    (wvalid && !wready) |=> (wvalid && $stable(wdata) && $stable(wstrb)))
    else $error("WDATA/WSTRB/WVALID changed while WVALID was waiting for WREADY");

  araddr_stable: assert property (@(posedge aclk) disable iff (!aresetn)
    (arvalid && !arready) |=> (arvalid && $stable(araddr)))
    else $error("ARADDR/ARVALID changed while ARVALID was waiting for ARREADY");

  // ---- slave-side rules (checks the DUT) ----
  bvalid_stable: assert property (@(posedge aclk) disable iff (!aresetn)
    (bvalid && !bready) |=> (bvalid && $stable(bresp)))
    else $error("BVALID dropped or BRESP changed before BREADY");

  rvalid_stable: assert property (@(posedge aclk) disable iff (!aresetn)
    (rvalid && !rready) |=> rvalid)
    else $error("RVALID dropped before RREADY");

  rdata_stable: assert property (@(posedge aclk) disable iff (!aresetn)
    (rvalid && !rready) |=> ($stable(rdata) && $stable(rresp)))
    else $error("RDATA/RRESP changed while RVALID was waiting for RREADY");

  bresp_legal: assert property (@(posedge aclk) disable iff (!aresetn)
    bvalid |-> (bresp == 2'b00 || bresp == 2'b10))
    else $error("illegal BRESP (only OKAY and SLVERR are produced)");

  rresp_legal: assert property (@(posedge aclk) disable iff (!aresetn)
    rvalid |-> (rresp == 2'b00 || rresp == 2'b10))
    else $error("illegal RRESP (only OKAY and SLVERR are produced)");

  // ---- functional coverage ----
  cov_write_okay:      cover property (@(posedge aclk) disable iff (!aresetn) bvalid && bready && bresp == 2'b00);
  cov_write_slverr:    cover property (@(posedge aclk) disable iff (!aresetn) bvalid && bready && bresp == 2'b10);
  cov_read_okay:       cover property (@(posedge aclk) disable iff (!aresetn) rvalid && rready && rresp == 2'b00);
  cov_read_slverr:     cover property (@(posedge aclk) disable iff (!aresetn) rvalid && rready && rresp == 2'b10);
  cov_partial_strobe:  cover property (@(posedge aclk) disable iff (!aresetn) wvalid && wready && wstrb != 4'hF && wstrb != 4'h0);
  cov_r_backpressure:  cover property (@(posedge aclk) disable iff (!aresetn) rvalid && !rready);
  cov_b_backpressure:  cover property (@(posedge aclk) disable iff (!aresetn) bvalid && !bready);
  // Ordering of the two write channels: aw_first is set when AW is accepted
  // while no W is outstanding (and vice versa); the cover fires when the
  // other channel's handshake completes that transaction later.
  logic aw_first, w_first;
  wire  aw_hs = awvalid && awready, w_hs = wvalid && wready;
  always_ff @(posedge aclk or negedge aresetn)
    if (!aresetn) begin aw_first <= 1'b0; w_first <= 1'b0; end
    else begin
      if (aw_hs && !w_hs && !w_first) aw_first <= 1'b1; else if (w_hs) aw_first <= 1'b0;
      if (w_hs && !aw_hs && !aw_first) w_first <= 1'b1; else if (aw_hs) w_first <= 1'b0;
    end
  cov_aw_before_w:     cover property (@(posedge aclk) disable iff (!aresetn) aw_first && w_hs);
  cov_w_before_aw:     cover property (@(posedge aclk) disable iff (!aresetn) w_first && aw_hs);
  cov_aw_with_w:       cover property (@(posedge aclk) disable iff (!aresetn) aw_hs && w_hs);
endmodule
