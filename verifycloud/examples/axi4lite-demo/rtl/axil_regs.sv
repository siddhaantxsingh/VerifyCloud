// AXI4-Lite register block: four 32-bit read/write registers, one read-only
// ID register, byte-lane write strobes, SLVERR for unmapped addresses.
//
// Address map (byte addresses):
//   0x00 CTRL    RW  reset 0x0000_0000
//   0x04 DATA0   RW  reset 0x0000_0000
//   0x08 DATA1   RW  reset 0x0000_0000
//   0x0C SCRATCH RW  reset 0xA5A5_0000
//   0x10 ID      RO  0x5643_0001 ("VC" v1); writes return SLVERR
//   other        SLVERR on read and write
//
// Demo design of VerifyCloud (synthetic; see examples/axi4lite-demo/README.md).
`timescale 1ns/1ps
module axil_regs #(
  parameter int ADDR_W = 8
) (
  input  logic              aclk,
  input  logic              aresetn,
  // write address
  input  logic [ADDR_W-1:0] awaddr,
  input  logic              awvalid,
  output logic              awready,
  // write data
  input  logic [31:0]       wdata,
  input  logic [3:0]        wstrb,
  input  logic              wvalid,
  output logic              wready,
  // write response
  output logic [1:0]        bresp,
  output logic              bvalid,
  input  logic              bready,
  // read address
  input  logic [ADDR_W-1:0] araddr,
  input  logic              arvalid,
  output logic              arready,
  // read data
  output logic [31:0]       rdata,
  output logic [1:0]        rresp,
  output logic              rvalid,
  input  logic              rready
);
  localparam logic [1:0] OKAY = 2'b00, SLVERR = 2'b10;
  localparam logic [31:0] ID_VALUE = 32'h5643_0001;

  logic [31:0] regs [4];

  // ---------------- write channel ----------------
  // Address and data are accepted independently; the write happens once both
  // have been captured, and the response is held until bready.
  logic              aw_held, w_held;
  logic [ADDR_W-1:0] aw_addr_q;
  logic [31:0]       w_data_q;
  logic [3:0]        w_strb_q;

  assign awready = !aw_held && !bvalid;
  assign wready  = !w_held && !bvalid;

  function automatic logic [31:0] apply_strobe(logic [31:0] old, logic [31:0] data, logic [3:0] strb);
    logic [31:0] r;
    for (int b = 0; b < 4; b++) r[8*b +: 8] = strb[b] ? data[8*b +: 8] : old[8*b +: 8];
    return r;
  endfunction

  always_ff @(posedge aclk or negedge aresetn) begin
    if (!aresetn) begin
      aw_held <= 1'b0;
      w_held  <= 1'b0;
      bvalid  <= 1'b0;
      bresp   <= OKAY;
      aw_addr_q <= '0;
      w_data_q  <= '0;
      w_strb_q  <= '0;
      regs[0] <= 32'h0;
      regs[1] <= 32'h0;
      regs[2] <= 32'h0;
      regs[3] <= 32'hA5A5_0000;
    end else begin
      if (awvalid && awready) begin
        aw_held   <= 1'b1;
        aw_addr_q <= awaddr;
      end
      if (wvalid && wready) begin
        w_held   <= 1'b1;
        w_data_q <= wdata;
        w_strb_q <= wstrb;
      end
      if (aw_held && w_held && !bvalid) begin
        if (aw_addr_q[ADDR_W-1:4] == '0 && aw_addr_q[1:0] == 2'b00) begin
          regs[aw_addr_q[3:2]] <= apply_strobe(regs[aw_addr_q[3:2]], w_data_q, w_strb_q);
          bresp <= OKAY;
        end else begin
          bresp <= SLVERR;
        end
        bvalid  <= 1'b1;
        aw_held <= 1'b0;
        w_held  <= 1'b0;
      end
      if (bvalid && bready) bvalid <= 1'b0;
    end
  end

  // ---------------- read channel ----------------
  logic [ADDR_W-1:0] ar_addr_q;

  assign arready = !rvalid;

  function automatic logic [33:0] read_reg(logic [ADDR_W-1:0] a);
    // returns {resp, data}
    if (a[1:0] != 2'b00)            return {SLVERR, 32'h0};
    if (a[ADDR_W-1:4] == '0)        return {OKAY, regs[a[3:2]]};
    if (a == ADDR_W'(8'h10))        return {OKAY, ID_VALUE};
    return {SLVERR, 32'h0};
  endfunction

  always_ff @(posedge aclk or negedge aresetn) begin
    if (!aresetn) begin
      rvalid    <= 1'b0;
      ar_addr_q <= '0;
    end else begin
      if (arvalid && arready) begin
        rvalid    <= 1'b1;
        ar_addr_q <= araddr;
      end else if (rvalid && rready) begin
        rvalid <= 1'b0;
      end
    end
  end

  // read data and response
  always_comb begin
    {rresp, rdata} = read_reg(araddr);
  end
endmodule
